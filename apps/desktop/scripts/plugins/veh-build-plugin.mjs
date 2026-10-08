/**
 * VoiceEdge Harness (VEH) desktop packaging plugin.
 * Controls branding, naming, protocol, and runtime directories for VoiceEdge Harness builds.
 */

/** @type {import('../desktop-build-plugin.d.mts').DesktopBuildPlugin} */
export const vehBuildPlugin = {
  name: 'veh-build-plugin',
  productName: 'VoiceEdge Harness',
  appId: 'com.voiceedge.harness',
  artifactName: 'veh-${version}-${os}-${arch}.${ext}',
  protocols: [{ name: 'VoiceEdge Harness', schemes: ['veh', 'dsh'] }],
  runtimeDirName: 'dsh',
  modifyConfig(config, env) {
    if (config.mac) {
      config.mac.extendInfo = {
        ...config.mac.extendInfo,
        NSMicrophoneUsageDescription: 'VoiceEdge Harness uses your microphone to transcribe speech into message drafts.',
      }
    }
  },
}

export default vehBuildPlugin
