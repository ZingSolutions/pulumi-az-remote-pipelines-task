import {
    loginToAzAsync, getStorageAccountAccessTokenAsync, checkIfBlobExistsAsync,
    generateSecretInKeyVaultIfNotExistsAsync, getSecretFromKeyVaultAsync,
    createBlobAsync, lockBlobAsync, unlockBlobAsync, CreateBlobOverwriteOption,
} from "./azureRm";
import { IServiceEndpoint } from "./models/IServiceEndpoint";
import { InputNames } from "./models/InputNames";
import { getExecOptions } from "./utils/toolRunner";
import * as toolLib from "azure-pipelines-tool-lib/tool";
import * as tl from "azure-pipelines-task-lib/task";
import * as path from "path";
import { StringStream } from "./models/StringStream";
import { IExecOptions } from "azure-pipelines-task-lib/toolrunner";

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

export async function runPulumiProgramAsync(
    stackName: string,
    remoteStoreAndVaultServiceEndpoint: IServiceEndpoint,
    deploymentServiceEndpoint: IServiceEndpoint): Promise<void> {

    //login to az (required to get storage access key & key vault access)
    await loginToAzAsync(remoteStoreAndVaultServiceEndpoint);

    tl.debug('referencing pulumi and logging out version in use to console');
    const pulumiPath = getPulumiPath();
    await tl.exec(pulumiPath, 'version');

    tl.debug('referencing required inputs');
    const storageAccountName: string = tl.getInput(InputNames.STORE_ACCOUNT_NAME, true);
    const containerName: string = tl.getInput(InputNames.STORE_CONTAINER_NAME, true);
    const keyVaultName: string = tl.getInput(InputNames.PASSPHRASE_KEY_VAULT_NAME, true);
    const keyVaultSecretName: string = tl.getInput(InputNames.PASSPHRASE_KEY_VAULT_SECRET_NAME, true);
    const workingDirectory = tl.getPathInput(InputNames.PULUMI_PROGRAM_DIRECTORY, false) || undefined;
    const cmd: string = tl.getInput(InputNames.PULUMI_COMMAND, true);
    const cmdArgs: string = tl.getInput(InputNames.PULUMI_COMMAND_ARGS, false) || '';
    const storageAccountAccessKey: string = await getStorageAccountAccessTokenAsync(storageAccountName);

    tl.debug('gathering required environment variables to build pulumi exec options');
    const envArgs: { [key: string]: string } = {};
    //for AZ CLI access via pulumi
    envArgs["ARM_CLIENT_ID"] = deploymentServiceEndpoint.clientId;
    envArgs["ARM_CLIENT_SECRET"] = deploymentServiceEndpoint.servicePrincipalKey;
    envArgs["ARM_TENANT_ID"] = deploymentServiceEndpoint.tenantId;
    envArgs["ARM_SUBSCRIPTION_ID"] = deploymentServiceEndpoint.subscriptionId;
    //for remote store access
    envArgs["AZURE_STORAGE_ACCOUNT"] = storageAccountName;
    envArgs["AZURE_STORAGE_KEY"] = storageAccountAccessKey;
    //set existing path
    envArgs["PATH"] = process.env["PATH"] || "";

    tl.debug(`logging in to pulumi using remote state stored in container named ${containerName} on blob storage account ${storageAccountName}`);
    let exitCode = await tl.exec(pulumiPath, ['login', '-c', `azblob://${containerName}`], getExecOptions(envArgs, workingDirectory));
    if (exitCode !== 0) {
        throw new Error(`Pulumi Login failed, exit code was: ${exitCode}`);
    }

    tl.debug(`command selected ${cmd}`);
    let saveOutputToFilePath: string | undefined;
    let isUpdateConfigCmd: boolean = false;
    let updateConfigSettingPrefixs: string[] = [];
    let updateConfigOutVarName: string = '';
    switch (cmd) {
        case 'stack init':
            //custom command, handle in own way and exit once done
            console.log('creating new stack.');
            const tempDirectory: string | undefined = process.env['AGENT_TEMPDIRECTORY'];
            if (!tempDirectory || !tempDirectory.trim()) {
                throw new Error('AGENT_TEMPDIRECTORY environment variable is not set');
            }
            const localLockFullPath: string = path.join(tempDirectory, 'local.lock');
            console.log('creating local lock file');
            tl.writeFile(localLockFullPath, 'lockfile');

            console.log('locking init');
            const initLockBlobName: string = "init-stack.lock";

            await createBlobAsync(
                storageAccountName,
                storageAccountAccessKey,
                containerName,
                initLockBlobName,
                localLockFullPath,
                CreateBlobOverwriteOption.DoNothingIfBlobExists);

            const initLockLeaseId = await lockBlobAsync(storageAccountName, storageAccountAccessKey, containerName, initLockBlobName);
            try {
                console.log('init stack');
                await initNewStackAsync(keyVaultName, keyVaultSecretName, stackName, envArgs, workingDirectory);

                console.log('stack created OK. creating lock file in blob storage if not already exists.');
                await createBlobAsync(
                    storageAccountName,
                    storageAccountAccessKey,
                    containerName,
                    getLockBlobName(keyVaultSecretName),
                    localLockFullPath,
                    CreateBlobOverwriteOption.DoNothingIfBlobExists);
            }
            finally {
                console.log('unlocking init.');
                await unlockBlobAsync(storageAccountName, storageAccountAccessKey, containerName, initLockBlobName, initLockLeaseId);
            }
            tl.setResult(tl.TaskResult.Succeeded, "new stack created OK");
            return;
        case 'stack exists':
            const stackExistsOutVarName = tl.getInput(InputNames.STACK_EXISTS_OUTPUT_VAR_NAME, true);
            const stackExists: boolean = await checkIfBlobExistsAsync(
                storageAccountName,
                storageAccountAccessKey,
                containerName,
                `.pulumi/stacks/${stackName}.json`);
            tl.setVariable(stackExistsOutVarName, stackExists.toString());
            return;
        case 'update config':
            isUpdateConfigCmd = true;
            updateConfigSettingPrefixs =
                tl.getInput(InputNames.UPDATE_CONFIG_SETTINGS_PREFIX, true)
                    .split(',').filter((e) => e && e.trim()).map((e) => e.trim().toUpperCase());
            updateConfigOutVarName = tl.getInput(InputNames.UPDATE_CONFIG_OUTPUT_VAR_NAME, true);
            break;
        case 'preview':
        case 'up':
        case 'destroy':
            if (tl.getBoolInput(InputNames.PULUMI_COMMAND_OUTPUT_TO_DISK_BOOLEAN, false)) {
                saveOutputToFilePath = tl.getPathInput(InputNames.PULUMI_COMMAND_OUTPUT_FILE_PATH, true);
            }
            break;
        default:
            throw new Error(`unexpected command: ${cmd}`);
    }

    // commands that get here run on the pulumi state and may alter it.
    // preform a lock now, and unlock once done.

    //lock
    const lockBlobName: string = getLockBlobName(keyVaultSecretName);
    const lockLeaseId: string = await lockBlobAsync(storageAccountName, storageAccountAccessKey, containerName, lockBlobName);

    //do work
    try {
        tl.debug('getting passphrase for stack from keyvault');
        const passphrase: string = await getSecretFromKeyVaultAsync(keyVaultName, keyVaultSecretName, true);
        if (!passphrase) {
            throw new Error(`failed to read passphrase for stack ${stackName} from secret ${keyVaultSecretName} in keyvault ${keyVaultName}`);
        }
        envArgs["PULUMI_CONFIG_PASSPHRASE"] = passphrase;

        tl.debug(`selecting stack ${stackName}`);
        const cmdExeOptions = getExecOptions(envArgs, workingDirectory);
        exitCode = await tl.exec(pulumiPath, ['stack', 'select', stackName], cmdExeOptions);
        if (exitCode !== 0) {
            throw new Error(`Pulumi stack select ${stackName} failed, exit code was: ${exitCode}`);
        }

        if (isUpdateConfigCmd) {
            let configHasChanged: boolean = false;
            const vars = tl.getVariables();
            const includePrefix = tl.getBoolInput(InputNames.UPDATE_CONFIG_INCLUDE_PREFIX, true);
            //process variables for each requested prefix
            for (const prefix of updateConfigSettingPrefixs) {
                const varStartIndex = prefix.length;
                console.log(`getting variables prefixed with ${prefix}`);
                for (let i = 0, l = vars.length; i < l; i++) {
                    if (vars[i].name.toUpperCase().startsWith(prefix)) {
                        let varName = vars[i].name;
                        if (!includePrefix) {
                            varName = varName.substr(varStartIndex);
                        }
                        const currentVal = await getConfigValueAsync(varName, pulumiPath, envArgs, workingDirectory);
                        if (vars[i].value !== currentVal) {
                            console.log(`config value is different for ${varName}`);
                            configHasChanged = true;
                            await setConfigValueAsync(pulumiPath, cmdExeOptions, varName, vars[i].value, vars[i].secret);
                        }
                    }
                }
            }

            tl.setVariable(updateConfigOutVarName, configHasChanged ? "some_change" : "no_change");
            console.log(`config has ${configHasChanged ? 'some' : 'no'} changes`);
            return;
        }

        //run other command (preview/up/destroy)
        tl.debug('build pulumi command to run');
        let cmdToRun: string = cmd;
        if (cmdArgs) {
            cmdToRun = `${cmd} ${cmdArgs}`;
        }
        let cmdOutStream: StringStream | undefined;
        if (saveOutputToFilePath) {
            cmdOutStream = new StringStream();
        }
        exitCode = await tl.tool(pulumiPath).line(cmdToRun).exec(getExecOptions(envArgs, workingDirectory, cmdOutStream));
        if (exitCode !== 0) {
            throw new Error(`running pulumi command ${cmdToRun} failed, exit code was: ${exitCode}`);
        }
        console.log('command run OK.');

        if (saveOutputToFilePath && cmdOutStream) {
            console.log('echoing results to console');
            const lines: string = cmdOutStream.getLines().join('\n');
            process.stdout.write(lines);
            console.log(`writing results to file: ${saveOutputToFilePath}`);
            tl.writeFile(saveOutputToFilePath, lines);
        }
    }
    finally {
        //unlock
        if (lockLeaseId) {
            try {
                await unlockBlobAsync(storageAccountName, storageAccountAccessKey, containerName, lockBlobName, lockLeaseId);
            }
            catch (err) {
                console.error('failed to unlock blob');
                console.error(err);
            }
        }
    }
}

function getLockBlobName(keyVaultSecretName: string) {
    return `state-locks/${keyVaultSecretName}.lock`;
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
    keyVaultSecretName: string,
    stackName: string,
    envArgs: { [key: string]: string },
    workingDirectory?: string): Promise<void> {

    tl.debug('get passphrase for this section');
    const passphrase: string = await generateSecretInKeyVaultIfNotExistsAsync(keyVaultName, keyVaultSecretName);

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

async function getConfigValueAsync(
    key: string,
    pulumiPath: string,
    envArgs: { [key: string]: string },
    workingDirectory?: string): Promise<string> {
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(pulumiPath, ['config', 'get', key], getExecOptions(envArgs, workingDirectory, outStream));
    if (exitCode !== 0) {
        console.warn(`failed to get config value ${key}, exit code was: ${exitCode}`);
        return '';
    }
    return outStream.getLastLine();
}

async function setConfigValueAsync(
    pulumiPath: string,
    cmdExeOptions: IExecOptions,
    key: string,
    value: string,
    encryptValue: boolean) {
    const exitCode = await tl.exec(pulumiPath, ['config', 'set', encryptValue ? '--secret' : '--plaintext', key, value], cmdExeOptions);
    if (exitCode !== 0) {
        throw new Error(`Pulumi config set ${key} ${encryptValue ? '--secret' : '--plaintext'} failed, exit code was: ${exitCode}`);
    }
}

const PULUMI_TOOL_NAME: string = "pulumi";
function getPulumiPath(): string {
    tl.debug('get pulumi tool path');
    return tl.which(PULUMI_TOOL_NAME, true);
}