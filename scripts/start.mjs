import { createIntake } from '../src/server.mjs';
import { createProvider } from '../provider/server.mjs';
const intake = await createIntake(process.env.ARCHIVE_DIR || '.local/archive');
const provider = createProvider();
await Promise.all([
  new Promise(resolve => intake.listen(Number(process.env.PORT || 3200), '0.0.0.0', resolve)),
  new Promise(resolve => provider.listen(Number(process.env.SOURCE_PORT || 4200), '0.0.0.0', resolve)),
]);
console.log(JSON.stringify({ 收件: intake.address().port, 来源: provider.address().port }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { intake.close(); provider.close(); });
