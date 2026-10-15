// En Render (variable RENDER=true) compila tras `npm install`, aunque el Build Command
// del servicio sea solo "npm install". En tu computadora no hace nada.
import { execSync } from 'node:child_process';

if (process.env.RENDER === 'true') {
  console.log('[provision] Render detectado: compilando…');
  execSync('npm run build', { stdio: 'inherit' });
}
