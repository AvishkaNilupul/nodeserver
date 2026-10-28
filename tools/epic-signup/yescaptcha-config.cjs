// Configure the official companion without exposing its key to the panel.
const VERSION='1.4.9';
const SHA256='d1543840f4323f4c1cefe718d0659d0a9df230ec2eba9455636cdda269ec2c3a';
function configure(source,clientKey){
 if(typeof clientKey!=='string'||!/^[A-Za-z0-9_-]{20,128}$/.test(clientKey))throw Error('Invalid YesCaptcha key');
 function replace(pattern,value){if(!pattern.test(source))throw Error('Unsupported companion configuration');source=source.replace(pattern,value);}
 replace(/clientKey:\s*''/, 'clientKey: '+JSON.stringify(clientKey));
 replace(/endTimes:\s*'20'/,"endTimes: '8'");
 replace(/(hcaptchaConfig:\s*\{[\s\S]*?isRealClick:)\s*false/,'$1 true');
 replace(/(funcaptchaConfig:\s*\{[\s\S]*?isOpen:)\s*true/,'$1 false');
 replace(/(recaptchaConfig:\s*\{[\s\S]*?isOpen:)\s*true/,'$1 false');
 replace(/(awsCaptchaConfig:\s*\{[\s\S]*?isOpen:)\s*true/,'$1 false');
 const allowed='/^https:\\/\\/(?:[a-z0-9-]+\\.)*epicgames\\.com\\//';
 replace(/whiteListConfig:\s*\{[\s\S]*?\n\s*\},/,"whiteListConfig: { isOpen: true, urlList: ["+JSON.stringify(allowed)+"] },");
 replace(/isHideKey:\s*false/,'isHideKey: true');
 return source;
}
module.exports={VERSION,SHA256,configure};
