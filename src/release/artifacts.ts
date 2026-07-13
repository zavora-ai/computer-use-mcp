import { createHash } from 'node:crypto'

export type ReleasePlatform = 'darwin' | 'win32' | 'linux'
export type ReleaseArch = 'arm64' | 'x64'
export type NativeBinaryFormat = 'mach-o' | 'pe' | 'elf'

export interface NativeArtifactInput {
  filename: string
  platform: ReleasePlatform
  arch: ReleaseArch
  packageName: string
  packageVersion: string
  bytes: Uint8Array
}

export interface NativeArtifactRecord {
  filename: string
  platform: ReleasePlatform
  arch: ReleaseArch
  format: NativeBinaryFormat
  packageName: string
  packageVersion: string
  size: number
  sha256: string
}

export interface ReleaseArtifactManifest {
  schemaVersion: 1
  protocol: 'computer-use-v8-release-artifacts'
  rootPackage: string
  rootVersion: string
  artifacts: NativeArtifactRecord[]
  manifestDigest: string
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function nativeBinaryFormat(bytes: Uint8Array): NativeBinaryFormat {
  if (bytes.length < 4) throw new TypeError('native artifact is too short')
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return 'elf'
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe'
  const magic = `${bytes[0]!.toString(16).padStart(2, '0')}${bytes[1]!.toString(16).padStart(2, '0')}${bytes[2]!.toString(16).padStart(2, '0')}${bytes[3]!.toString(16).padStart(2, '0')}`
  if (['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic)) return 'mach-o'
  throw new TypeError('unrecognized native artifact format')
}

export function nativeBinaryArchitecture(bytes: Uint8Array, format = nativeBinaryFormat(bytes)): ReleaseArch {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === 'elf') {
    if (bytes.length < 20 || bytes[5] !== 1) throw new TypeError('unsupported ELF header or byte order')
    const machine = view.getUint16(18, true)
    if (machine === 0x3e) return 'x64'
    if (machine === 0xb7) return 'arm64'
    throw new TypeError(`unsupported ELF machine ${machine}`)
  }
  if (format === 'pe') {
    if (bytes.length < 64) throw new TypeError('truncated PE DOS header')
    const offset = view.getUint32(0x3c, true)
    if (offset + 6 > bytes.length || bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x45
      || bytes[offset + 2] !== 0 || bytes[offset + 3] !== 0) throw new TypeError('invalid PE signature')
    const machine = view.getUint16(offset + 4, true)
    if (machine === 0x8664) return 'x64'
    if (machine === 0xaa64) return 'arm64'
    throw new TypeError(`unsupported PE machine ${machine}`)
  }
  const magic = view.getUint32(0, false)
  if (magic === 0xcafebabe || magic === 0xbebafeca) throw new TypeError('fat Mach-O is not allowed in target-specific packages')
  if (bytes.length < 8) throw new TypeError('truncated Mach-O header')
  const littleEndian = magic === 0xcffaedfe
  const cpu = view.getUint32(4, littleEndian)
  if (cpu === 0x01000007) return 'x64'
  if (cpu === 0x0100000c) return 'arm64'
  throw new TypeError(`unsupported Mach-O CPU type ${cpu}`)
}

function expectedFormat(platform: ReleasePlatform): NativeBinaryFormat {
  return platform === 'darwin' ? 'mach-o' : platform === 'win32' ? 'pe' : 'elf'
}

const supportedTargets = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'])

function hasExactTargetIdentity(item: Pick<NativeArtifactRecord, 'filename' | 'platform' | 'arch' | 'packageName'>): boolean {
  const target = `${item.platform}-${item.arch}`
  return supportedTargets.has(target)
    && item.filename === `computer-use-napi.${target}.node`
    && item.packageName === `@zavora-ai/computer-use-mcp-${target}`
}

export function expectedNativeBinaryFormat(platform: ReleasePlatform): NativeBinaryFormat {
  return expectedFormat(platform)
}

export function releaseArtifactManifestDigest(manifest: ReleaseArtifactManifest): string {
  const body = structuredClone(manifest)
  body.manifestDigest = ''
  return digest(canonical(body))
}

export function buildReleaseArtifactManifest(input: {
  rootPackage: string
  rootVersion: string
  artifacts: NativeArtifactInput[]
}): ReleaseArtifactManifest {
  if (!input.rootPackage || !input.rootVersion || !input.artifacts.length) throw new TypeError('release artifact manifest requires package, version, and artifacts')
  const filenames = new Set<string>()
  const packages = new Set<string>()
  const artifacts = input.artifacts.map(item => {
    if (filenames.has(item.filename) || packages.has(item.packageName)) throw new TypeError('duplicate native artifact filename or package')
    filenames.add(item.filename); packages.add(item.packageName)
    if (item.packageVersion !== input.rootVersion) throw new TypeError(`${item.packageName} version is not lockstep`)
    if (!hasExactTargetIdentity(item)) throw new TypeError(`${item.filename} target identity mismatch`)
    if (item.bytes.byteLength === 0) throw new TypeError(`${item.filename} is empty`)
    const format = nativeBinaryFormat(item.bytes)
    if (format !== expectedFormat(item.platform)) throw new TypeError(`${item.filename} has ${format} format for ${item.platform}`)
    const binaryArch = nativeBinaryArchitecture(item.bytes, format)
    if (binaryArch !== item.arch) throw new TypeError(`${item.filename} contains ${binaryArch} machine code, expected ${item.arch}`)
    return {
      filename: item.filename, platform: item.platform, arch: item.arch, format,
      packageName: item.packageName, packageVersion: item.packageVersion,
      size: item.bytes.byteLength, sha256: digest(item.bytes),
    } satisfies NativeArtifactRecord
  }).sort((a, b) => a.filename.localeCompare(b.filename))
  const manifest: ReleaseArtifactManifest = {
    schemaVersion: 1, protocol: 'computer-use-v8-release-artifacts',
    rootPackage: input.rootPackage, rootVersion: input.rootVersion, artifacts, manifestDigest: '',
  }
  manifest.manifestDigest = releaseArtifactManifestDigest(manifest)
  return manifest
}

export function verifyReleaseArtifactManifest(manifest: ReleaseArtifactManifest): boolean {
  try {
    if (manifest.schemaVersion !== 1 || manifest.protocol !== 'computer-use-v8-release-artifacts'
      || !manifest.rootPackage || !manifest.rootVersion || !manifest.artifacts.length
      || !/^sha256:[a-f0-9]{64}$/.test(manifest.manifestDigest)
      || releaseArtifactManifestDigest(manifest) !== manifest.manifestDigest) return false
    const files = new Set<string>(); const packages = new Set<string>()
    for (const item of manifest.artifacts) {
      if (files.has(item.filename) || packages.has(item.packageName)) return false
      files.add(item.filename); packages.add(item.packageName)
      if (item.packageVersion !== manifest.rootVersion || item.format !== expectedFormat(item.platform)
        || !hasExactTargetIdentity(item)
        || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(item.sha256)) return false
    }
    return true
  } catch { return false }
}

export function verifyArtifactBytes(record: NativeArtifactRecord, bytes: Uint8Array): boolean {
  try {
    return bytes.byteLength === record.size
      && nativeBinaryFormat(bytes) === record.format
      && nativeBinaryArchitecture(bytes, record.format) === record.arch
      && digest(bytes) === record.sha256
  } catch { return false }
}
