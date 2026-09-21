import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { KEYCHAIN_SERVICE } from './jev-constants.mjs';

const execFile = promisify(execFileCallback);
const scriptDir = dirname(fileURLToPath(import.meta.url));

export class MacOSKeychainCredentialStore {
  constructor({ execFileImpl = execFile, account = userInfo().username, platform = process.platform } = {}) {
    this.execFileImpl = execFileImpl;
    this.account = account;
    this.platform = platform;
  }

  async has() {
    if (this.platform !== 'darwin') return false;
    try {
      await this.execFileImpl('/usr/bin/security', [
        'find-generic-password', '-a', this.account, '-s', KEYCHAIN_SERVICE
      ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384 });
      return true;
    } catch {
      return false;
    }
  }

  async get() {
    if (this.platform !== 'darwin') return undefined;
    try {
      const { stdout } = await this.execFileImpl('/usr/bin/security', [
        'find-generic-password', '-a', this.account, '-s', KEYCHAIN_SERVICE, '-w'
      ], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384 });
      const value = String(stdout).trim();
      return value ? { apiKey: value, source: 'macos-keychain' } : undefined;
    } catch {
      return undefined;
    }
  }
}

export class WindowsDpapiCredentialStore {
  constructor({
    execFileImpl = execFile,
    platform = process.platform,
    credentialPath = process.env.JEV_CREDENTIAL_PATH
      ?? join(process.env.LOCALAPPDATA ?? '', 'ModelTaskRouting', 'typesafe.dpapi'),
    powershellPath = join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    readerPath = join(scriptDir, 'read-jev-credential-windows.ps1')
  } = {}) {
    this.execFileImpl = execFileImpl;
    this.platform = platform;
    this.credentialPath = credentialPath;
    this.powershellPath = powershellPath;
    this.readerPath = readerPath;
  }

  async has() {
    return this.platform === 'win32' && Boolean(this.credentialPath) && existsSync(this.credentialPath);
  }

  async get() {
    if (this.platform !== 'win32' || !existsSync(this.readerPath)) return undefined;
    const pipeToken = randomUUID();
    const childEnvironment = { ...process.env, JEV_DPAPI_PIPE_NONCE: pipeToken };
    delete childEnvironment.TYPESAFE_API_KEY;
    const args = ['-NoProfile', '-NonInteractive', '-File', this.readerPath, '-PrivatePipeToken', pipeToken];
    if (this.credentialPath) args.push('-CredentialPath', this.credentialPath);
    try {
      const { stdout } = await this.execFileImpl(this.powershellPath, args, {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 16_384, windowsHide: true,
        env: childEnvironment
      });
      const value = String(stdout).trim();
      return value ? { apiKey: value, source: 'windows-dpapi-current-user' } : undefined;
    } catch {
      return undefined;
    }
  }
}

export class EnvironmentCredentialStore {
  constructor({ env = process.env, allow = false } = {}) {
    this.env = env;
    this.allow = allow || Boolean(env.CI);
  }

  async has() {
    return this.allow && Boolean(this.env.TYPESAFE_API_KEY?.trim());
  }

  async get() {
    if (!this.allow) return undefined;
    const value = this.env.TYPESAFE_API_KEY?.trim();
    return value ? { apiKey: value, source: 'environment-explicit' } : undefined;
  }
}

export function platformCredentialStore(options = {}) {
  if (options.platform === 'darwin' || (!options.platform && process.platform === 'darwin')) {
    return new MacOSKeychainCredentialStore(options);
  }
  if (options.platform === 'win32' || (!options.platform && process.platform === 'win32')) {
    return new WindowsDpapiCredentialStore(options);
  }
  return { get: async () => undefined };
}

export async function resolveCredential({
  credentialStore = platformCredentialStore(),
  environment = process.env,
  allowEnvironment = environment.JEV_ALLOW_ENV_CREDENTIAL === '1' || Boolean(environment.CI)
} = {}) {
  // The legacy Windows wrapper injects a DPAPI-decoded key only into this child.
  if (process.platform === 'win32' && environment.JEV_CREDENTIAL_SOURCE === 'windows-dpapi') {
    const apiKey = environment.TYPESAFE_API_KEY?.trim();
    if (apiKey) return { apiKey, source: 'windows-dpapi-current-user' };
  }
  const native = await credentialStore.get();
  if (native) return native;
  return new EnvironmentCredentialStore({ env: environment, allow: allowEnvironment }).get();
}

export async function credentialStatus({
  credentialStore = platformCredentialStore(),
  environment = process.env,
  allowEnvironment = environment.JEV_ALLOW_ENV_CREDENTIAL === '1' || Boolean(environment.CI)
} = {}) {
  if (typeof credentialStore.has === 'function' && await credentialStore.has()) {
    const source = credentialStore instanceof MacOSKeychainCredentialStore
      ? 'macos-keychain'
      : credentialStore instanceof WindowsDpapiCredentialStore
        ? 'windows-dpapi-current-user'
        : 'native-credential-store';
    return { configured: true, source };
  }
  // Injectable test/custom stores may only expose get(). Platform stores never
  // reach this branch, so doctor/check do not read a native secret.
  if (typeof credentialStore.has !== 'function') {
    const native = await credentialStore.get();
    if (native) return { configured: true, source: native.source ?? 'native-credential-store' };
  }
  const environmentStore = new EnvironmentCredentialStore({ env: environment, allow: allowEnvironment });
  const environmentConfigured = await environmentStore.has();
  return {
    configured: environmentConfigured,
    source: environmentConfigured ? 'environment-explicit' : null
  };
}
