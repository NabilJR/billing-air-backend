/**
 * Update Admin Password Script
 * Run this script to reset admin password to 'admin123'
 * 
 * Usage: node scripts/update-password.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function updatePassword() {
  console.log('Updating admin password...');
  
  try {
    const client = await pool.connect();
    
    // Generate new hash for admin123
    const password_hash = await bcrypt.hash('admin123', 10);
    console.log('Generated hash:', password_hash);
    
    // Update admin user
    const result = await client.query(
      `UPDATE users 
       SET password_hash = $1 
       WHERE username = 'admin' 
       RETURNING id, username, email`,
      [password_hash]
    );
    
    if (result.rows.length === 0) {
      // Create admin user if not exists
      await client.query(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         VALUES ('admin', 'admin@waterbilling.com', $1, 'System Administrator', 'admin', true)
         ON CONFLICT (username) DO UPDATE SET password_hash = $1`,
        [password_hash]
      );
      console.log('✅ Admin user created with new password');
    } else {
      console.log('✅ Admin password updated successfully');
      console.log('User:', result.rows[0]);
    }
    
    // Verify
    const verify = await client.query(
      'SELECT password_hash FROM users WHERE username = $1',
      ['admin']
    );
    
    const isMatch = await bcrypt.compare('admin123', verify.rows[0].password_hash);
    console.log('Password verification:', isMatch ? '✅ Valid' : '❌ Invalid');
    
    client.release();
    await pool.end();
    
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

updatePassword();