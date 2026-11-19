import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid native app version');
const cap = path.join(root, 'node_modules/@capacitor/cli/bin/capacitor');
if (!fs.existsSync(path.join(root, 'ios/App/App.xcodeproj'))) {
  const child = spawnSync(process.execPath, [cap, 'add', 'ios'], { cwd: root, stdio: 'inherit' });
  if (child.status !== 0) process.exit(child.status ?? 1);
}
const plistPath = path.join(root, 'ios/App/App/Info.plist');
let plist = fs.readFileSync(plistPath, 'utf8');
plist = plist.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, '$1yunhui.me$2');
// Local gateway addresses are chosen by the user. Native HTTP handles their network requests;
// the WebView itself keeps loading only the bundled application.
const additions = [
  ['NSLocalNetworkUsageDescription', '<string>连接您选择的电脑，查看 AI 客户端、模型用量和历史会话。</string>'],
  ['NSAppTransportSecurity', '<dict><key>NSAllowsArbitraryLoads</key><true/><key>NSAllowsLocalNetworking</key><true/></dict>'],
];
for (const [key, value] of additions) {
  if (!plist.includes(`<key>${key}</key>`)) plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t${value}\n</dict>\n</plist>\n`);
}
fs.writeFileSync(plistPath, plist);
const projectPath = path.join(root, 'ios/App/App.xcodeproj/project.pbxproj');
let project = fs.readFileSync(projectPath, 'utf8');
project = project.replace(/IPHONEOS_DEPLOYMENT_TARGET = [\d.]+;/g, 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
project = project.replace(/MARKETING_VERSION = [\d.]+;/g, `MARKETING_VERSION = ${version};`);
fs.writeFileSync(projectPath, project);
const podfile = path.join(root, 'ios/App/Podfile');
if (fs.existsSync(podfile)) fs.writeFileSync(podfile, fs.readFileSync(podfile, 'utf8').replace(/platform :ios, '[^']+'/g, "platform :ios, '16.0'"));
const icon = path.join(root, 'assets/icon-1024.png');
if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));
console.log('iOS project prepared → mobile/ios/App/App.xcworkspace');
if (process.platform !== 'darwin') console.log('Native compilation still requires macOS + Xcode. This step generates source only.');
