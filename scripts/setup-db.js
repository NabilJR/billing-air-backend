/**
 * Database Setup Script
 * Run this script to execute the database schema
 * 
 * Usage: node scripts/setup-db.js
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function executeSchema() {
  const schemaPath = path.join(__dirname, '..', '..', 'database', 'schema.sql');
  
  console.log('📂 Reading schema file...');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  
  console.log('🔌 Connecting to database...');
  
  try {
    const client = await pool.connect();
    console.log('✅ Connected to database');
    
    console.log('📝 Executing schema...');
    await client.query(schema);
    console.log('✅ Schema executed successfully!');
    
    // Verify tables
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('\n📋 Created tables:');
    result.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
    
    client.release();
    await pool.end();
    console.log('\n🎉 Database setup complete!');
    
  } catch (error) {
    console.error('❌ Error executing schema:', error.message);
    await pool.end();
    process.exit(1);
  }
}

executeSchema();