// Generates capsolver extension config.js in the EXACT format the extension's
// naive parser expects: `export const defaultConfig = { key: 'value' }` with
// single-quoted strings and bare booleans/numbers. JSON.stringify breaks it.

function generateCapsolverConfig(apiKey) {
  return `export const defaultConfig = {
  apiKey: '${apiKey}',
  appId: 'CF30F23A-B149-4411-B39E-7B844CBA9662',
  useCapsolver: true,
  manualSolving: false,
  solvedCallback: 'captchaSolvedCallback',
  solvedFailedCallback: '',
  onDetectedCallback: '',
  useProxy: false,
  proxyType: 'http',
  hostOrIp: '',
  port: '',
  proxyLogin: '',
  proxyPassword: '',
  enabledForBlacklistControl: false,
  blackUrlList: [],
  enabledForRecaptcha: true,
  enabledForRecaptchaV3: true,
  enabledForHCaptcha: true,
  enabledForFunCaptcha: true,
  enabledForImageToText: true,
  enabledForAwsCaptcha: true,
  enabledForCloudflare: true,
  reCaptchaMode: 'click',
  hCaptchaMode: 'click',
  reCaptchaDelayTime: 0,
  hCaptchaDelayTime: 0,
  textCaptchaDelayTime: 0,
  awsDelayTime: 0,
  captchaDelayTime: 0,
  reCaptchaRepeatTimes: 10,
  reCaptcha3RepeatTimes: 10,
  hCaptchaRepeatTimes: 10,
  funCaptchaRepeatTimes: 10,
  textCaptchaRepeatTimes: 10,
  awsRepeatTimes: 10,
  reCaptcha3TaskType: 'ReCaptchaV3TaskProxyLess',
  textCaptchaSourceAttribute: 'capsolver-image-to-text-source',
  textCaptchaResultAttribute: 'capsolver-image-to-text-result',
  textCaptchaModule: 'common',
  showSolveButton: false,
};
`;
}

module.exports = { generateCapsolverConfig };
