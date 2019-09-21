import { IServiceEndpoint } from "./models/IServiceEndpoint";
import { getExecOptions } from "./utils/toolRunner";
import { StringStream } from "./models/StringStream";
import * as tl from 'azure-pipelines-task-lib/task';

export async function loginToAzAsync(serviceEndpoint: IServiceEndpoint): Promise<void> {
    const azPath: string = getAzPath();
    tl.debug('login to az using service principal');
    let exitCode = await tl.exec(azPath,
        ["login", "--service-principal",
            "--username", serviceEndpoint.clientId,
            "--password", serviceEndpoint.servicePrincipalKey,
            "--tenant", serviceEndpoint.tenantId],
        getExecOptions());
    if (exitCode !== 0) {
        throw new Error(`az login failed, exit code was: ${exitCode}`);
    }

    tl.debug(`set az subscription to ${serviceEndpoint.subscriptionId}`);
    exitCode = await tl.exec(azPath,
        ["account", "set", "--subscription", serviceEndpoint.subscriptionId],
        getExecOptions());
    if (exitCode !== 0) {
        throw new Error(`az account set --subscription ${serviceEndpoint.subscriptionId} failed, exit code was: ${exitCode}`);
    }
}

export async function getStorageAccountAccessTokenAsync(storageAccountName: string): Promise<string> {
    const azPath: string = getAzPath();
    tl.debug(`getting first access token for storage account: ${storageAccountName}`);
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath,
        ["storage", "account", "keys", "list", "--account-name", storageAccountName, "--query", "[0].value", "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`az command to get storage account acccess key failed, exit code was: ${exitCode}`);
    }
    const token: string = outStream.getLastLine();
    if (!token) {
        throw new Error("failed to parse storage account access token from az command output stream");
    }
    return token;
}

export async function setSecretInKeyVaultAsync(vaultName: string, secretName: string, keyValue: string, keyDescription?: string): Promise<void> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath, ["keyvault", "secret", "set",
        "--vault-name", vaultName,
        "--name", secretName,
        "--value", keyValue,
        "--description", `${keyDescription || ""}`,
        "--query", "value", "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`failed to set secret value *** for key ${secretName} in keyVault ${vaultName}, exit code was: ${exitCode}`);
    }
    if (outStream.getLastLine() !== keyValue) {
        throw new Error("failed to parse expected set secret value from az command output stream, value was different to keyValue requested to be saved");
    }
}

export async function getSecretFromKeyVaultAsync(vaultName: string, secretName: string): Promise<string> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath, ["keyvault", "secret", "show",
        "--vault-name", vaultName,
        "--name", secretName,
        "--query", "value", "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`failed to get secret ${secretName} from keyvault ${vaultName}, exit code was: ${exitCode}`);
    }
    return outStream.getLastLine() || "";
}

function getAzPath(): string {
    tl.debug('get az tool path');
    return tl.which('az', true);
}