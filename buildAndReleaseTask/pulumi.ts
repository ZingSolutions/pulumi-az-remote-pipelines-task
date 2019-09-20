import * as toolLib from "azure-pipelines-tool-lib/tool";
import * as tl from "azure-pipelines-task-lib/task";
import * as path from "path";
import Crypto from "crypto";
import { loginToAzAsync, getStorageAccountAccessTokenAsync, setSecretInKeyVaultAsync, getSecretFromKeyVaultAsync } from "azureRm";
import { IServiceEndpoint } from "models/IServiceEndpoint";
import { InputNames } from "models/InputNames";
import { getExecOptions } from "utils/toolRunner";

export async function checkPulumiInstallAsync(requiredVersion: string): Promise<void> {
    tl.debug('pulumi install requested');
    const variableName: string = "INSTALLED_PULUMI_VERSION";
    const existingPulumiVersion = tl.getVariable(variableName);
    if (existingPulumiVersion) {
        if (requiredVersion !== existingPulumiVersion) {
            throw new Error(`pulumi version missmatch. requested: ${requiredVersion} installed: ${existingPulumiVersion}`);
        }
    }

    const existingToolPath = toolLib.findLocalTool(PULUMI_TOOL_NAME, requiredVersion);
    if (existingToolPath) {
        tl.debug(`pulumi version ${requiredVersion} has already been installed and is in cache, prepending path and skipping installation.`);
        toolLib.prependPath(path.join(existingToolPath, "bin"));
        return;
    }

    tl.debug(`about to download and install pulumi ${requiredVersion}`);
    const os = tl.osType();
    tl.debug(`OS DETECTED: ${os}`);
    switch (os.toLowerCase()) {
        case "windows_nt":
            await installPulumiWindowsAsync(requiredVersion);
            break;
        case "macos":
        case "linux":
            await installPulumiLinuxAsync(requiredVersion, os.toLowerCase());
            break;
        default:
            throw new Error(`Unexpected OS "${os.toLowerCase()}"`);
    }
    tl.setVariable(variableName, requiredVersion);
}

export async function runPulumiProgramAsync(stackName: string, serviceEndpoint: IServiceEndpoint): Promise<void> {
    //login to az (required to get storage access key & key vault access)
    await loginToAzAsync(serviceEndpoint);

    tl.debug('referencing pulumi and logging out version in use to console');
    const pulumiPath = getPulumiPath();
    await tl.exec(pulumiPath, 'version');

    tl.debug('referencing required inputs');
    const storageAccountName: string = tl.getInput(InputNames.STORE_ACCOUNT_NAME, true);
    const containerName: string = tl.getInput(InputNames.STORE_CONTAINER_NAME, true);
    const keyVaultName: string = tl.getInput(InputNames.SECRET_KEY_VAULT_NAME, true);
    const workingDirectory = tl.getInput(InputNames.PULUMI_PROGRAM_DIRECTORY, false) || undefined;
    const cmd: string = tl.getInput(InputNames.PULUMI_COMMAND, true);
    const cmdArgs: string = tl.getInput(InputNames.PULUMI_COMMAND_ARGS, false) || '';

    tl.debug('gathering required environment variables to build pulumi exec options');
    const envArgs: { [key: string]: string } = {};
    //for AZ CLI access via pulumi
    envArgs["ARM_CLIENT_ID"] = serviceEndpoint.clientId;
    envArgs["ARM_CLIENT_SECRET"] = serviceEndpoint.servicePrincipalKey;
    envArgs["ARM_TENANT_ID"] = serviceEndpoint.tenantId;
    envArgs["ARM_SUBSCRIPTION_ID"] = serviceEndpoint.subscriptionId;
    //for remote store access
    envArgs["AZURE_STORAGE_ACCOUNT"] = storageAccountName;
    envArgs["AZURE_STORAGE_KEY"] = await getStorageAccountAccessTokenAsync(storageAccountName);
    //set existing path
    envArgs["PATH"] = process.env["PATH"] || "";

    tl.debug(`logging in to pulumi using remote state stored in container named ${containerName} on blob storage account ${storageAccountName}`);
    let exitCode = await tl.exec(pulumiPath, ['login', '-c', `azblob://${containerName}`], getExecOptions(envArgs, workingDirectory));
    if (exitCode !== 0) {
        throw new Error(`Pulumi Login failed, exit code was: ${exitCode}`);
    }

    tl.debug(`command selected ${cmd}`);
    if (cmd === 'stack init') {
        //custom command, handle in own way and exit once done
        await initNewStackAsync(keyVaultName, stackName, envArgs, workingDirectory);
        tl.setResult(tl.TaskResult.Succeeded, "new stack created OK");
        return;
    }

    //all other commands follow this flow
    tl.debug('getting passphrase for stack from keyvault');
    const passphrase: string = await getSecretFromKeyVaultAsync(keyVaultName, stackName);
    if (!passphrase) {
        throw new Error(`failed to read passphrase for stack ${stackName} from keyvault ${keyVaultName}`);
    }
    envArgs["PULUMI_CONFIG_PASSPHRASE"] = passphrase;

    tl.debug(`selecting stack ${stackName}`);
    exitCode = await tl.exec(pulumiPath, ['stack', 'select', stackName], getExecOptions(envArgs, workingDirectory));
    if (exitCode !== 0) {
        throw new Error(`Pulumi stack select ${stackName} failed, exit code was: ${exitCode}`);
    }

    tl.debug('build pulumi command to run');
    let cmdToRun: string = cmd;
    if (cmdArgs) {
        cmdToRun = `${cmd} ${cmdArgs}`;
    }
    exitCode = await tl.tool(pulumiPath).line(cmdToRun).exec(getExecOptions(envArgs, workingDirectory));
    if (exitCode !== 0) {
        throw new Error(`running pulumi command ${cmdToRun} failed, exit code was: ${exitCode}`);
    }
}

async function installPulumiWindowsAsync(version: string): Promise<void> {
    const downloadUrl = `https://get.pulumi.com/releases/sdk/pulumi-v${version}-windows-x64.zip`;
    const temp = await toolLib.downloadTool(downloadUrl);
    const extractTemp = await toolLib.extractZip(temp);
    toolLib.prependPath(path.join(extractTemp, "pulumi/bin"));
}

async function installPulumiLinuxAsync(version: string, os: string): Promise<void> {
    const downloadUrl = `https://get.pulumi.com/releases/sdk/pulumi-v${version}-${os}-x64.tar.gz`;
    const temp = await toolLib.downloadTool(downloadUrl);
    const extractTemp = await toolLib.extractTar(temp);
    toolLib.prependPath(path.join(extractTemp, "pulumi"));
}

async function initNewStackAsync(
    keyVaultName: string,
    stackName: string,
    envArgs: { [key: string]: string },
    workingDirectory?: string): Promise<void> {
    tl.debug('create new crypto random passphrase');
    const buf = Crypto.randomBytes(64);
    const passphrase: string = buf.toString('base64');

    tl.debug('create secret to hold passphrase in key vault');
    await setSecretInKeyVaultAsync(keyVaultName, stackName, passphrase, `passphrase for pulumi stack: ${stackName}`);

    tl.debug('init new pulumi stack');
    envArgs["PULUMI_CONFIG_PASSPHRASE"] = passphrase;
    const pulumiPath: string = getPulumiPath();
    const exitCode: number = await tl.exec(pulumiPath,
        ['stack', 'init', stackName, '--secrets-provider', 'passphrase'],
        getExecOptions(envArgs, workingDirectory));
    if (exitCode !== 0) {
        throw new Error(`Pulumi Command: stack init ${stackName} --secrets-provider passphrase failed, exit code was: ${exitCode}`);
    }
}

const PULUMI_TOOL_NAME: string = "pulumi";
function getPulumiPath(): string {
    tl.debug('get pulumi tool path');
    return tl.which(PULUMI_TOOL_NAME, true);
}