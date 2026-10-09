// Compatibility for existing local launchers; all paths now use Vite/React SSR.
const [command, ...args] = process.argv.slice(2);
if (args.length || !['dev', 'build'].includes(command)) throw new Error('Expected dev or build. Use PORT to select a development port.');
if (command === 'build') await import('./build.mjs');
else {
  process.argv = [process.execPath, process.argv[1], '--dev'];
  await import('./run-server.mjs');
}
