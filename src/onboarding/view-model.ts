import {
  sanitizeOnboardingPermissionGuidance,
  type OnboardingConfiguration,
  type OnboardingState,
} from './manager.js'

export type SetupStepStatus = 'pending' | 'active' | 'passed' | 'failed' | 'configured' | 'completed'

export interface SetupViewModel {
  onboardingId: string
  stage: OnboardingState['stage']
  revision: number
  progress: number
  nextAction?: 'diagnose' | 'test_capture' | 'show_pointer' | 'test_semantic' | 'acknowledge_emergency' | 'configure' | 'complete'
  steps: Array<{
    id: 'diagnostics' | 'capture' | 'pointer' | 'semantic' | 'emergency' | 'policy' | 'finish'
    status: SetupStepStatus
    detail?: string
  }>
  capabilities: {
    capture: boolean
    virtualPointer: boolean
    semantic: boolean
    physicalEmergencyStop: boolean
  }
  emergencyStop?: { chord: string; backend: string; physicalOnly: boolean; acknowledged: boolean }
  permissions: Array<{
    id: string
    label: string
    status: 'pass' | 'warn' | 'fail' | 'skip' | 'unknown'
    required: boolean
    canRequestInProcess: boolean
    canOpenSettings: boolean
    remediation: string
    settingsUri?: string
  }>
  policy?: {
    filesystemRootCount: number
    allowedAppCount: number
    scrapeEnabled: boolean
    auditEnabled: boolean
  }
  restartRequired: boolean
  environmentKeys: string[]
}

/** Disclosure-safe projection shared by terminal, Electron, and Tauri setup surfaces. */
export function createSetupViewModel(
  state: Readonly<OnboardingState>,
  configuration?: Readonly<OnboardingConfiguration>,
): SetupViewModel {
  const doctor = state.checks.doctor
  const capture = state.checks.capture
  const pointer = state.checks.pointer
  const semantic = state.checks.semantic
  const emergency = state.checks.emergency
  const profile = state.profile
  const completed = state.stage === 'completed'
  const steps: SetupViewModel['steps'] = [
    {
      id: 'diagnostics', status: doctor ? (doctor.passed ? 'passed' : 'failed') : 'pending',
      ...(doctor ? { detail: `${doctor.failedChecks} failed, ${doctor.warningChecks} warnings` } : {}),
    },
    { id: 'capture', status: capture ? (capture.passed ? 'passed' : 'failed') : 'pending' },
    {
      id: 'pointer',
      status: pointer?.tested ? (pointer.passed ? 'passed' : 'failed') : pointer?.shown ? 'active' : 'pending',
    },
    { id: 'semantic', status: semantic ? (semantic.passed ? 'passed' : 'failed') : 'pending' },
    {
      id: 'emergency',
      status: emergency ? (emergency.acknowledgedByUser ? 'passed' : 'failed') : 'pending',
      ...(emergency ? { detail: emergency.physicalChordSupported
        ? `Physical chord: ${emergency.chord}`
        : `API stop only (${emergency.backend})` } : {}),
    },
    { id: 'policy', status: profile ? 'configured' : 'pending' },
    { id: 'finish', status: completed ? 'completed' : 'pending' },
  ]
  const completedSteps = steps.filter(step => ['passed', 'failed', 'configured', 'completed'].includes(step.status)).length
  let nextAction: SetupViewModel['nextAction']
  if (!doctor) nextAction = 'diagnose'
  else if (!capture) nextAction = 'test_capture'
  else if (!pointer?.shown) nextAction = 'show_pointer'
  else if (!pointer.tested) nextAction = undefined
  else if (!semantic) nextAction = 'test_semantic'
  else if (!emergency?.acknowledgedByUser) nextAction = 'acknowledge_emergency'
  else if (!profile) nextAction = 'configure'
  else if (!completed) nextAction = 'complete'
  return {
    onboardingId: state.onboardingId,
    stage: state.stage,
    revision: state.revision,
    progress: Math.round((completedSteps / steps.length) * 100),
    ...(nextAction ? { nextAction } : {}),
    steps,
    capabilities: {
      capture: capture?.passed ?? false,
      virtualPointer: pointer?.passed ?? false,
      semantic: semantic?.passed ?? false,
      physicalEmergencyStop: emergency?.physicalChordSupported ?? false,
    },
    ...(emergency ? { emergencyStop: {
      chord: emergency.chord, backend: emergency.backend, physicalOnly: emergency.physicalOnly,
      acknowledged: emergency.acknowledgedByUser,
    } } : {}),
    permissions: sanitizeOnboardingPermissionGuidance(
      state.checks.permissions?.entries ?? [],
      state.profile?.platform ?? process.platform,
    ).map(permission => ({ ...permission, canOpenSettings: false })),
    ...(profile ? { policy: {
      filesystemRootCount: profile.filesystemRoots.length,
      allowedAppCount: profile.allowedAppIds.length,
      scrapeEnabled: profile.allowScrape,
      auditEnabled: profile.persistAudit,
    } } : {}),
    restartRequired: configuration?.restartRequired ?? false,
    environmentKeys: Object.keys(configuration?.environment ?? {}).sort(),
  }
}
