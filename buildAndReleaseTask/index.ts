import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from "azure-pipelines-tool-lib/tool";
import { IExecOptions } from "azure-pipelines-task-lib/toolrunner";
import * as path from "path";
import Axios from 'axios';
import Crypto from 'crypto';
import Stream from 'stream';

// tslint:disable-next-line: no-floating-promises
(async () => {

    const TOOL_NAME: string = "pulumi";

    class InputNames {
        public static AZURE_SUBSCRIPTION: string = "azureSubscription";
        public static PULUMI_VERSION: string = "pulumiVersion";
        public static STORE_ACCOUNT_NAME: string = "storageAccountName";
        public static STORE_CONTAINER_NAME: string = "containerName";
        public static SECRET_KEY_VAULT_NAME: string = "keyVaultName";
        public static PULUMI_STACK: string = "stack";
        public static PULUMI_PROGRAM_DIRECTORY: string = "cwd";
        public static PULUMI_COMMAND: string = "cmd";
        public static PULUMI_COMMAND_ARGS: string = "args";
    }

    class VariableNames {
        public static INSTALLED_PULUMI_VERSION: string = "INSTALLED_PULUMI_VERSION";
    }

    class StringStream extends Stream.Writable {
        private contents = '';

        constructor() {
            super();
            Stream.Writable.call(this);
        }

        // tslint:disable-next-line:variable-name
        public _write(data: any, _encoding: any, next: any) {
            this.contents += data;
            next();
        }

        public getContents() {
            return this.contents;
        }
    }

    interface IServiceEndpoint {
        subscriptionId: string;
        servicePrincipalKey: string;
        tenantId: string;
        clientId: string;
    }

    function getServiceEndpoint(connectedServiceName: string): IServiceEndpoint {
        return {
            clientId: tl.getEndpointAuthorizationParameter(connectedServiceName, "serviceprincipalid", false),
            servicePrincipalKey: tl.getEndpointAuthorizationParameter(connectedServiceName, "serviceprincipalkey", false),
            subscriptionId: tl.getEndpointDataParameter(connectedServiceName, "subscriptionid", false),
            tenantId: tl.getEndpointAuthorizationParameter(connectedServiceName, "tenantid", false),
        };
    }

    async function installPulumiAsync(version: string) {
        const os = tl.osType();
        tl.debug(`OS DETECTED: ${os}`);
        switch (os.toLowerCase()) {
            case "windows_nt":
                await installPulumiWindowsAsync(version);
                break;
            case "macos":
            case "linux":
                await installPulumiLinuxAsync(version, os.toLowerCase());
                break;
            default:
                throw new Error(`Unexpected OS "${os.toLowerCase()}"`);
        }
    }

    async function installPulumiWindowsAsync(version: string) {
        const downloadUrl = `https://get.pulumi.com/releases/sdk/pulumi-v${version}-windows-x64.zip`;
        const temp = await toolLib.downloadTool(downloadUrl);
        const extractTemp = await toolLib.extractZip(temp);
        toolLib.prependPath(path.join(extractTemp, "pulumi/bin"));
    }

    async function installPulumiLinuxAsync(version: string, os: string) {
        const downloadUrl = `https://get.pulumi.com/releases/sdk/pulumi-v${version}-${os}-x64.tar.gz`;
        const temp = await toolLib.downloadTool(downloadUrl);
        const extractTemp = await toolLib.extractTar(temp);
        toolLib.prependPath(path.join(extractTemp, "pulumi"));
    }

    function getExecOptions(envMap: { [key: string]: string }, workingDirectory: string, outStream?: StringStream): IExecOptions {
        return {
            cwd: workingDirectory,
            env: envMap,

            // Set defaults.
            errStream: process.stderr,
            failOnStdErr: false,
            ignoreReturnCode: true,
            outStream: outStream ? outStream : process.stdout,
            silent: false,
            windowsVerbatimArguments: false,
        };
    }

    async function loginToAz(azPath: string, serviceEndpoint: IServiceEndpoint, exeOptions: IExecOptions) {
        tl.debug('login to az using service principal');
        let exitCode = await tl.exec(azPath,
            ["login", "--service-principal",
                "--username", serviceEndpoint.clientId,
                "--password", serviceEndpoint.servicePrincipalKey,
                "--tenant", serviceEndpoint.tenantId],
            exeOptions);
        if (exitCode !== 0) {
            throw new Error(`az login failed, exit code was: ${exitCode}`);
        }

        tl.debug(`set az subscription to ${serviceEndpoint.subscriptionId}`);
        exitCode = await tl.exec(azPath, ["account", "set", "--subscription", serviceEndpoint.subscriptionId], exeOptions);
        if (exitCode !== 0) {
            throw new Error(`az account set --subscription ${serviceEndpoint.subscriptionId} failed, exit code was: ${exitCode}`);
        }
    }

    async function initNewStack(
        keyVaultName: string,
        stackName: string,
        azPath: string,
        toolPath: string,
        envArgs: { [key: string]: string },
        workingDirectory: string) {
        tl.debug('create new crypto random passphrase');
        const buf = Crypto.randomBytes(64);
        const passphrase: string = buf.toString('base64');
        tl.debug('create secret to hold passphrase in key vault');
        let exitCode = await tl.exec(azPath, ["keyvault", "secret", "set",
            "--name", stackName, "--vault-name", keyVaultName,
            "--description", `passphrase for pulumi stack: ${stackName}`,
            "--value", passphrase,
            "--query", "value", "-o", "tsv"],
            getExecOptions(envArgs, '', new StringStream()));
        if (exitCode !== 0) {
            throw new Error(`failed to create passphrase in keyvault for stack: ${stackName}, exit code was: ${exitCode}`);
        }

        //set the passphrase and init the stack
        envArgs["PULUMI_CONFIG_PASSPHRASE"] = passphrase;
        exitCode = await tl.exec(toolPath,
            ['stack', 'init', stackName, '--secrets-provider', 'passphrase'],
            getExecOptions(envArgs, workingDirectory, new StringStream()));
        if (exitCode !== 0) {
            throw new Error(`Pulumi Command: stack init ${stackName} --secrets-provider passphrase failed, exit code was: ${exitCode}`);
        }
    }

    async function runPulumiProgramAsync(stackName: string, serviceEndpoint: IServiceEndpoint) {
        // Print the version.
        const toolPath = tl.which(TOOL_NAME);
        tl.debug(`${TOOL_NAME} toolPath: ${toolPath}`);
        if (!toolPath) {
            throw new Error(`${TOOL_NAME} not found!`);
        }
        await tl.exec(toolPath, 'version');

        const storageAccountName: string = tl.getInput(InputNames.STORE_ACCOUNT_NAME, true);

        tl.debug('gathering required environment variables');
        const envArgs: { [key: string]: string } = {};
        //for AZ CLI access via pulumi
        envArgs["ARM_CLIENT_ID"] = serviceEndpoint.clientId;
        envArgs["ARM_CLIENT_SECRET"] = serviceEndpoint.servicePrincipalKey;
        envArgs["ARM_TENANT_ID"] = serviceEndpoint.tenantId;
        envArgs["ARM_SUBSCRIPTION_ID"] = serviceEndpoint.subscriptionId;

        //set existing path
        const pathEnv = process.env["PATH"];
        envArgs["PATH"] = pathEnv || "";

        //for az access via toolRunner
        tl.debug('login to az');
        const azPath = tl.which('az');
        await loginToAz(azPath, serviceEndpoint, getExecOptions(envArgs, ''));

        //for blob storage access (for state store)
        tl.debug('get storage account access token');
        const storageKeyStream: StringStream = new StringStream();
        let exitCode = await tl.exec(azPath,
            ["storage", "account", "keys", "list",
                "--account-name", storageAccountName,
                "--query", "[0].value", "-o", "tsv"],
            getExecOptions(envArgs, '', storageKeyStream));
        if (exitCode !== 0) {
            throw new Error(`failed to get storage account access key, exit code was ${exitCode}`);
        }
        const storageAccountKey: string = storageKeyStream.getContents();
        if (!storageAccountKey || !storageAccountKey.trim()) {
            throw new Error("failed to get storage account access key from output stream");
        }
        console.warn(storageAccountName);
        console.warn(storageAccountKey.trim());
        envArgs["AZURE_STORAGE_ACCOUNT"] = storageAccountName;
        envArgs["AZURE_STORAGE_KEY"] = storageAccountKey.trim();

        const containerName: string = tl.getInput(InputNames.STORE_CONTAINER_NAME, true);
        tl.debug(`logging in to pulumi using remote state stored in container named ${containerName}`);
        exitCode = await tl.exec(toolPath, ['login', '-c', `azblob://${containerName}`], getExecOptions(envArgs, ''));
        if (exitCode !== 0) {
            throw new Error(`Pulumi Login failed, exit code was: ${exitCode}`);
        }

        tl.debug('configuring working directory and default exe options');
        const workingDirectory = tl.getInput(InputNames.PULUMI_PROGRAM_DIRECTORY, false) || ".";
        const exeOptions = getExecOptions(envArgs, workingDirectory);

        let cmd: string = tl.getInput(InputNames.PULUMI_COMMAND, true);
        tl.debug(`command selected ${cmd}`);
        const keyVaultName: string = tl.getInput(InputNames.SECRET_KEY_VAULT_NAME, true);

        if (cmd === 'stack init') {
            await initNewStack(keyVaultName, stackName, azPath, toolPath, envArgs, workingDirectory);
            tl.setResult(tl.TaskResult.Succeeded, "new stack created OK");
            return;
        }

        tl.debug('getting stack secret');
        const passphraseStream = new StringStream();
        const passphraseExeOptions = getExecOptions(envArgs, workingDirectory, passphraseStream);
        await tl.exec(azPath, ["keyvault", "secret", "show",
            "--name", stackName, "--vault-name", keyVaultName, "--query", "value", "-o", "tsv"],
            passphraseExeOptions);
        if (exitCode !== 0) {
            throw new Error(`failed to get passphtase from keyvault, exit code was ${exitCode}`);
        }
        const passphrase: string = passphraseStream.getContents().trim();
        if (!passphrase) {
            throw new Error("failed to read passphrase from passphraseStream");
        }
        exeOptions.env["PULUMI_CONFIG_PASSPHRASE"] = passphrase;

        tl.debug(`selecting stack ${stackName}`);
        exitCode = await tl.exec(toolPath, ['stack', 'select', stackName], exeOptions);
        if (exitCode !== 0) {
            throw new Error(`Pulumi select stack ${stackName} failed, exit code was: ${exitCode}`);
        }

        tl.debug('running pulumi command');
        const cmdArgs: string = tl.getInput(InputNames.PULUMI_COMMAND_ARGS, false);
        if (cmdArgs) {
            cmd = `${cmd} ${cmdArgs}`;
        }
        exitCode = await tl.tool(toolPath).line(cmd).exec(exeOptions);
        if (exitCode !== 0) {
            throw new Error(`running pulumi command ${cmd} failed, exit code was: ${exitCode}`);
        }
    }

    try {
        tl.setResourcePath(path.join(__dirname, "task.json"));
        tl.debug('task starting ...');

        //validate stack name
        const stackName = tl.getInput(InputNames.PULUMI_STACK, true);
        if (!(new RegExp(/^[a-zA-Z][a-zA-Z0-9-]+$/)).test(stackName)) {
            throw new Error(`Invald stack name, ${stackName}.
            Name must only contain alphanumeric characters or dashes and must start with a letter.`);
        }

        tl.debug('checking specified azure subscription has service endpoint configured ...');
        const connectedServiceName = tl.getInput(InputNames.AZURE_SUBSCRIPTION, true);
        tl.debug(`azureSubscription: ${connectedServiceName}`);
        const serviceEndpoint = getServiceEndpoint(connectedServiceName);
        tl.debug(`service endpoint retrieved with client ID ${serviceEndpoint.clientId}`);

        tl.debug('verifying pulumi install ...');
        let pulumiVersion: string = tl.getInput(InputNames.PULUMI_VERSION, false);
        if (pulumiVersion && pulumiVersion.trim() && pulumiVersion.trim().toLowerCase() !== 'latest') {
            tl.debug(`requested Pulumi Version is: ${pulumiVersion}`);
        }
        else {
            // no version specifed use latest
            pulumiVersion = (await Axios.get<string>('https://pulumi.io/latest-version', {
                headers: {
                    "Content-Type": "text/plain",
                    "User-Agent": "pulumi-az-remote-pipelines-task",
                },
            })).data.trim();
            if (!pulumiVersion) {
                throw new Error("failed to get latest version of pulumi from api call to: https://pulumi.io/latest-version");
            }
            tl.debug(`no specific version of Pulumi requested, will use latest: ${pulumiVersion}`);
        }

        const existingPulumiVersion = tl.getVariable(VariableNames.INSTALLED_PULUMI_VERSION);
        if (existingPulumiVersion) {
            if (pulumiVersion !== existingPulumiVersion) {
                throw new Error(`pulumi version missmatch. requested: ${pulumiVersion} installed: ${existingPulumiVersion}`);
            }
            tl.debug(`pulumi version ${pulumiVersion} show already be installed.`);
        }

        // install pulumi
        const toolPath = toolLib.findLocalTool(TOOL_NAME, pulumiVersion);
        if (!toolPath) {
            tl.debug(`pulummi version ${pulumiVersion} not in cache, will install now`);
            await installPulumiAsync(pulumiVersion);
            tl.setVariable(VariableNames.INSTALLED_PULUMI_VERSION, pulumiVersion);
        }
        else {
            tl.debug(`pulumi version ${pulumiVersion} found in cache, skipped download & installation, will just add to path`);
            toolLib.prependPath(path.join(toolPath, "bin"));
        }

        tl.debug('pulumi installed, about to run pulumi program');
        await runPulumiProgramAsync(stackName, serviceEndpoint);
        tl.debug('pulumi progam complete');
        tl.setResult(tl.TaskResult.Succeeded, "task ended OK");
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err, true);
    }
})();