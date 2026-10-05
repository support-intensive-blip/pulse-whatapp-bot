const userService = require('./src/services/userService');
const Database = require('better-sqlite3');

userService.getOrCreate('916309499278');
userService.getOrCreate('919281433572');

const db = new Database('/app/data/assistant.db');
console.log(JSON.stringify(db.prepare('SELECT id, phone FROM users').all(), null, 2));
