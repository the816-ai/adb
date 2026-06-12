require('../env').loadEnv();
const { backupDatabase, listBackups } = require('../ops/backup');

const result = backupDatabase('cli');
if (!result.ok) {
  console.error('Backup failed:', result.reason);
  process.exit(1);
}
console.log('Backup OK:', result.path);
console.log('Recent backups:', listBackups().slice(0, 5).map((b) => b.name).join(', '));
