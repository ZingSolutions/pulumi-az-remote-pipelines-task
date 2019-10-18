import { IServiceEndpoint } from "./models/IServiceEndpoint";
import { getExecOptions } from "./utils/toolRunner";
import { StringStream } from "./models/StringStream";
import * as tl from 'azure-pipelines-task-lib/task';
import * as Crypto from "crypto";

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

/**
 * generates new secret with crypto random value in keyvault if it does
 * not already exist. returns the secret value.
 * @param vaultName name of vault to add secret to
 * @param secretName name of secret to add (if it doesnt already exist)
 */
export async function generateSecretInKeyVaultIfNotExistsAsync(vaultName: string, secretName: string): Promise<string> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();

    tl.debug('check for existing keyvault secret');
    const existingValue = getSecretFromKeyVaultAsync(vaultName, secretName, false);
    if (existingValue) {
        return existingValue;
    }

    tl.debug('create new crypto random value');
    const buf = Crypto.randomBytes(64);
    const keyValue: string = buf.toString('base64');

    tl.debug('creating keyvault secret');
    const exitCode = await tl.exec(azPath, ["keyvault", "secret", "set",
        "--vault-name", vaultName,
        "--name", secretName,
        "--value", keyValue,
        "--query", "value", "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`failed to set secret value *** for key ${secretName} in keyVault ${vaultName}, exit code was: ${exitCode}`);
    }
    if (outStream.getLastLine() !== keyValue) {
        throw new Error("failed to parse expected set secret value from az command output stream, value was different to keyValue requested to be saved");
    }
    return keyValue;
}

/**
 * returns a secret value from keyvault
 * @param vaultName name of the vault to read the secret from
 * @param secretName name of the secret to get the value of
 * @param required if set to true will error if the secret cannont be found,
 *  however if set to false will return an empty string,
 */
export async function getSecretFromKeyVaultAsync(vaultName: string, secretName: string, required: boolean): Promise<string> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath, ["keyvault", "secret", "show",
        "--vault-name", vaultName,
        "--name", secretName,
        "--query", "value", "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode == 3 && !required) {
        return "";
    }
    else if (exitCode !== 0) {
        throw new Error(`failed to get secret ${secretName} from keyvault ${vaultName}, exit code was: ${exitCode}`);
    }
    return outStream.getLastLine() || "";
}

export async function checkIfBlobExistsAsync(
    accountName: string,
    accountAccessKey: string,
    containerName: string,
    blobName: string): Promise<boolean> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath, ["storage", "blob", "exists",
        "--account-name", accountName,
        "--account-key", accountAccessKey,
        "--container-name", containerName,
        "--name", blobName, "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`failed to query az to check if blob ${blobName}
        exists in container ${containerName} under account ${accountName}, exit code was: ${exitCode}`);
    }
    const res: string = outStream.getLastLine();
    switch (res) {
        case "True":
            return true;
        case "False":
            return false;
        default:
            throw new Error(`unexpected result when checking if blob ${blobName}
            exist in container ${containerName} under account ${accountName}.
            Expecting "True" or "False" instead recieved ${res}`);
    }
}

export enum CreateBlobOverwriteOption {
    ErrorIfBlobExists,
    DoNothingIfBlobExists,
    OverwriteIfBlobExists
}

/**
 * Wiil create a new blob with the given parameters.
 * Note: if a blob already exists in the same location a overwrite will be attempted.
 */
export async function createBlobAsync(
    accountName: string,
    accountAccessKey: string,
    containerName: string,
    blobName: string,
    localFilePath: string,
    overwrite: CreateBlobOverwriteOption): Promise<void> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();

    const args = ["storage", "blob", "upload",
        "--account-name", accountName,
        "--account-key", accountAccessKey,
        "--container-name", containerName,
        "--file", localFilePath,
        "--name", blobName];
    switch (overwrite) {
        case CreateBlobOverwriteOption.DoNothingIfBlobExists:
        case CreateBlobOverwriteOption.ErrorIfBlobExists:
            args.push("--if-none-match");
            args.push("*");
            break;
    }
    args.push("-o");
    args.push("tsv");

    const exitCode = await tl.exec(azPath, args,
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        if (overwrite == CreateBlobOverwriteOption.DoNothingIfBlobExists
            &&
            (
                outStream.getLines().join('\n').indexOf('BlobAlreadyExists')
                || outStream.getLines().join('\n').indexOf('LeaseIdMissing')
            )
        ) {
            //ignore BlobAlreadyExists or LeaseIdMissing error as caller
            //requested do nothing in this case.
            return;
        }
        throw new Error(`failed to use az to create blob ${blobName}
        in container ${containerName} under account ${accountName}, exit code was: ${exitCode}`);
    }
}

/**
 * attempts to create a new lease for the
 * given blob and returns the new lease id.
 */
export async function lockBlobAsync(
    accountName: string,
    accountAccessKey: string,
    containerName: string,
    blobName: string): Promise<string> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath, ["storage", "blob", "lease", "acquire",
        "--account-name", accountName,
        "--account-key", accountAccessKey,
        "--container-name", containerName,
        "--lease-duration", -1,
        "--blob-name", blobName, "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`failed to use az to lease blob ${blobName}
        in container ${containerName} under account ${accountName}, exit code was: ${exitCode}`);
    }
    const leaseKey = outStream.getLastLine();
    if (leaseKey && leaseKey.trim()) {
        return leaseKey.trim();
    }
    throw new Error(`failed to use az to lease blob ${blobName}
        in container ${containerName} under account ${accountName}, lease key was missing from output stream`);
}

export async function unlockBlobAsync(
    accountName: string,
    accountAccessKey: string,
    containerName: string,
    blobName: string,
    leaseId: string): Promise<void> {
    const azPath: string = getAzPath();
    const outStream: StringStream = new StringStream();
    const exitCode = await tl.exec(azPath, ["storage", "blob", "lease", "release",
        "--account-name", accountName,
        "--account-key", accountAccessKey,
        "--container-name", containerName,
        "--lease-id", leaseId,
        "--blob-name", blobName, "-o", "tsv"],
        getExecOptions(undefined, undefined, outStream));
    if (exitCode !== 0) {
        throw new Error(`failed to use az to release lease ${leaseId} from blob ${blobName}
        in container ${containerName} under account ${accountName}, exit code was: ${exitCode}`);
    }
}

function getAzPath(): string {
    tl.debug('get az tool path');
    return tl.which('az', true);
}