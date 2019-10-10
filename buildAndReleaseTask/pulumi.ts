import {
    loginToAzAsync, getStorageAccountAccessTokenAsync, checkIfBlobExistsAsync,
    setSecretInKeyVaultAsync, getSecretFromKeyVaultAsync,
    createBlobAsync, lockBlobAsync, unlockBlobAsync,
} from "./azureRm";
import { IServiceEndpoint } from "./models/IServiceEndpoint";
import { InputNames } from "./models/InputNames";
import { getExecOptions } from "./utils/toolRunner";
import * as toolLib from "azure-pipelines-tool-lib/tool";
import * as tl from "azure-pipelines-task-lib/task";
import * as path from "path";
import * as Crypto from "crypto";
import { promises as fs } from 'fs';
import { StringStream } from "models/StringStream";
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
    const workingDirectory = tl.getPathInput(InputNames.PULUMI_PROGRAM_DIRECTORY, false) || undefined;
    const cmd: string = tl.getInput(InputNames.PULUMI_COMMAND, true);
    const cmdArgs: string = tl.getInput(InputNames.PULUMI_COMMAND_ARGS, false) || '';
    const storageAccountAccessKey: string = await getStorageAccountAccessTokenAsync(storageAccountName);

    tl.debug('gathering required environment variables to build pulumi exec options');
    const envArgs: { [key: string]: string } = {};
    //for AZ CLI access via pulumi
    envArgs["ARM_CLIENT_ID"] = serviceEndpoint.clientId;
    envArgs["ARM_CLIENT_SECRET"] = serviceEndpoint.servicePrincipalKey;
    envArgs["ARM_TENANT_ID"] = serviceEndpoint.tenantId;
    envArgs["ARM_SUBSCRIPTION_ID"] = serviceEndpoint.subscriptionId;
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
    let updateConfigSettingPrefix: string = '';
    let updateConfigOutVarName: string = '';
    switch (cmd) {
        case 'stack init':
            //custom command, handle in own way and exit once done
            const tempDirectory: string | undefined = process.env['AGENT_TEMPDIRECTORY'];
            if (!tempDirectory || !tempDirectory.trim()) {
                throw new Error('AGENT_TEMPDIRECTORY environment variable is not set');
            }
            const localLockFullPath: string = path.join(tempDirectory, 'stack.lock');
            console.log('creating local lock file');
            await fs.writeFile(localLockFullPath, 'lockfile');
            console.log('creating new stack.');
            await initNewStackAsync(keyVaultName, stackName, envArgs, workingDirectory);
            console.log('stack created OK. creating lock file in blob storage.');
            await createBlobAsync(
                storageAccountName,
                storageAccountAccessKey,
                containerName,
                getLockBlobName(stackName),
                localLockFullPath);
            console.log('stack lock file created OK.');
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
            updateConfigSettingPrefix = tl.getInput(InputNames.UPDATE_CONFIG_SETTINGS_PREFIX, true);
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
    const lockBlobName: string = getLockBlobName(stackName);
    const lockLeaseId: string = await lockBlobAsync(storageAccountName, storageAccountAccessKey, containerName, lockBlobName);

    //do work
    try {
        tl.debug('getting passphrase for stack from keyvault');
        const passphrase: string = await getSecretFromKeyVaultAsync(keyVaultName, stackName);
        if (!passphrase) {
            throw new Error(`failed to read passphrase for stack ${stackName} from keyvault ${keyVaultName}`);
        }
        envArgs["PULUMI_CONFIG_PASSPHRASE"] = passphrase;

        tl.debug(`selecting stack ${stackName}`);
        const cmdExeOptions = getExecOptions(envArgs, workingDirectory);
        exitCode = await tl.exec(pulumiPath, ['stack', 'select', stackName], cmdExeOptions);
        if (exitCode !== 0) {
            throw new Error(`Pulumi stack select ${stackName} failed, exit code was: ${exitCode}`);
        }

        if (isUpdateConfigCmd) {
            updateConfigSettingPrefix = updateConfigSettingPrefix.toUpperCase();
            const varStartIndex = updateConfigSettingPrefix.length;
            let configHasChanged: boolean = false;
            console.log(`getting variables prefixed with ${updateConfigSettingPrefix}`);
            const vars = tl.getVariables();
            for (let i = 0, l = vars.length; i < l; i++) {
                const varName = vars[i].name.substr(varStartIndex);
                const currentVal = await getConfigValueAsync(varName, pulumiPath, envArgs, workingDirectory);
                if (vars[i].value !== currentVal) {
                    configHasChanged = true;
                    await setConfigValueAsync(pulumiPath, cmdExeOptions, varName, vars[i].value, vars[i].secret);
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
            await fs.writeFile(saveOutputToFilePath, lines);
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

function getLockBlobName(stackName: string) {
    return `state-locks/${stackName}.lock`;
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

async function getConfigValueAsync(
    key: string,
    pulumiPath: string,
    envArgs: { [key: string]: string },
    workingDirectory?: string): Promise<string> {
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(pulumiPath, ['config', 'get', key], getExecOptions(envArgs, workingDirectory, outStream));
    if (exitCode !== 0) {
        throw new Error(`Pulumi config get ${key} failed, exit code was: ${exitCode}`);
    }
    return outStream.getLines().join('\n');
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