import 'dotenv/config';
import mysql from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) { console.error('No DATABASE_URL'); process.exit(1); }

const conn = await mysql.createConnection(url);
const [rows] = await conn.execute("SELECT * FROM agent_bots WHERE botSlug = 'jason'");
console.log(JSON.stringify(rows, null, 2));
await conn.end();
