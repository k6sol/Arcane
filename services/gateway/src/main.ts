/** Entry point: `node src/main.ts` (Node 24+ runs TypeScript directly). Configuration comes from the environment only. */
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { createMailSender } from './mail.ts';
import { createUpstream } from './providers.ts';
import { createGatewayServer } from './server.ts';

const config = loadConfig(process.env);
const db = openDatabase(config.databaseFile);
const { server, close } = createGatewayServer({ config, db, upstream: createUpstream(), sendMail: createMailSender(config) });
server.listen(config.port, config.host, () => {
  console.log('Arcane gateway listening on ' + config.host + ':' + config.port + ' (public URL ' + config.publicUrl + ', ' +
    config.models.length + ' models, payments ' + (config.stripe.secretKey ? (config.stripe.secretKey.includes('_test_') ? 'test mode' : 'live') : 'not configured') + ')');
});
const shutdown = () => { close(); setTimeout(() => { db.close(); process.exit(0); }, 2000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
