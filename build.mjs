// 后端打包: esbuild 把 src/index.js 连同它 import 的模块打成一个 worker.js。
// wrangler.jsonc 的 build.command 会在 dev/deploy 前自动跑一次; build.watch_dir=./src
// 让 `wrangler dev` 在 src 变化时自动重新打包, 保住「改完刷新就有」的体验。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.js'],
  bundle: true,
  format: 'esm',
  outfile: 'worker.js',
  target: 'es2022',
  minify: false,
  sourcemap: false,
});
console.log('已打包 → worker.js');
