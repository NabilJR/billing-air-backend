/**
 * Database Migration Script
 * Run this script to migrate the database schema
 * 
 * Usage: 
 *   node scripts/migrate-db.js        - Create tables if not exist (safe)
 *   node scripts/migrate-db.js fresh - Drop all tables and recreate
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const isFresh = process.argv.includes('fresh');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrate() {
  console.log('🔌 Connecting to database...');
  
  try {
    const client = await pool.connect();
    console.log('✅ Connected to database');
    
    if (isFresh) {
      console.log('🗑️ Dropping existing tables...');
      await client.query(`
        DROP TABLE IF EXISTS audit_logs CASCADE;
        DROP TABLE IF EXISTS notifications CASCADE;
        DROP TABLE IF EXISTS payment_confirmations CASCADE;
        DROP TABLE IF EXISTS users CASCADE;
        DROP TABLE IF EXISTS meter_readings CASCADE;
        DROP TABLE IF EXISTS payments CASCADE;
        DROP TABLE IF EXISTS bills CASCADE;
        DROP TABLE IF EXISTS billing_cycles CASCADE;
        DROP TABLE IF EXISTS tariffs CASCADE;
        DROP TABLE IF EXISTS customers CASCADE;
      `);
      console.log('✅ Tables dropped');
    }
    
    // Create tables individually with IF NOT EXISTS
    console.log('📝 Creating tables...');
    
    // Enable UUID extension
    await client.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    
    // 1. Customers Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          customer_number VARCHAR(20) UNIQUE NOT NULL,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE,
          phone VARCHAR(20),
          address TEXT,
          district VARCHAR(50),
          city VARCHAR(50),
          postal_code VARCHAR(10),
          meter_number VARCHAR(30) UNIQUE NOT NULL,
          meter_reading DECIMAL(10, 2) DEFAULT 0,
          customer_type VARCHAR(20) DEFAULT 'residential',
          status VARCHAR(20) DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ customers table');
    
    // 2. Tariffs Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tariffs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          tariff_name VARCHAR(50) NOT NULL,
          customer_type VARCHAR(20) NOT NULL,
          min_usage_cubic DECIMAL(10, 2) DEFAULT 0,
          price_per_cubic DECIMAL(10, 2) NOT NULL,
          admin_fee DECIMAL(10, 2) DEFAULT 0,
          late_fee DECIMAL(10, 2) DEFAULT 0,
          effective_date DATE NOT NULL,
          end_date DATE,
          is_active BOOLEAN DEFAULT true,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ tariffs table');
    
    // 3. Billing Cycles Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS billing_cycles (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          cycle_name VARCHAR(50) NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          meter_reading_deadline DATE,
          payment_deadline DATE,
          status VARCHAR(20) DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ billing_cycles table');
    
    // 4. Bills Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bills (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          bill_number VARCHAR(30) UNIQUE NOT NULL,
          customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
          billing_cycle_id UUID REFERENCES billing_cycles(id),
          previous_reading DECIMAL(10, 2) NOT NULL,
          current_reading DECIMAL(10, 2) NOT NULL,
          usage_cubic DECIMAL(10, 2) NOT NULL,
          tariff_id UUID REFERENCES tariffs(id),
          water_charge DECIMAL(10, 2) NOT NULL,
          admin_fee DECIMAL(10, 2) DEFAULT 0,
          late_fee DECIMAL(10, 2) DEFAULT 0,
          other_charges DECIMAL(10, 2) DEFAULT 0,
          total_amount DECIMAL(10, 2) NOT NULL,
          paid_amount DECIMAL(10, 2) DEFAULT 0,
          status VARCHAR(20) DEFAULT 'unpaid',
          due_date DATE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ bills table');
    
    // Add paid_amount column if it doesn't exist (for existing databases)
    try {
      await client.query(`ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(10, 2) DEFAULT 0`);
      console.log('✅ paid_amount column added to bills table');
    } catch (e) {
      console.log('ℹ️ paid_amount column already exists');
    };
    
    // 5. Payments Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          payment_number VARCHAR(30) UNIQUE NOT NULL,
          bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
          customer_id UUID REFERENCES customers(id),
          payment_amount DECIMAL(10, 2) NOT NULL,
          payment_method VARCHAR(20) NOT NULL,
          payment_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          transaction_id VARCHAR(100),
          bank_name VARCHAR(50),
          account_number VARCHAR(30),
          payment_proof TEXT,
          status VARCHAR(20) DEFAULT 'pending',
          confirmed_by UUID,
          confirmed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ payments table');
    
    // 6. Meter Readings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS meter_readings (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
          billing_cycle_id UUID REFERENCES billing_cycles(id),
          reading_date DATE NOT NULL,
          meter_reading DECIMAL(10, 2) NOT NULL,
          reading_image TEXT,
          notes TEXT,
          recorded_by VARCHAR(100),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ meter_readings table');
    
    // 7. Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          username VARCHAR(50) UNIQUE NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          full_name VARCHAR(100) NOT NULL,
          role VARCHAR(20) DEFAULT 'staff',
          phone VARCHAR(20),
          is_active BOOLEAN DEFAULT true,
          last_login TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ users table');
    
    // 8. Payment Confirmations Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_confirmations (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          payment_id UUID REFERENCES payments(id) ON DELETE CASCADE,
          confirmed_by UUID REFERENCES users(id),
          confirmation_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          notes TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ payment_confirmations table');
    
    // 9. Notifications Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
          title VARCHAR(100) NOT NULL,
          message TEXT NOT NULL,
          notification_type VARCHAR(20) DEFAULT 'general',
          is_read BOOLEAN DEFAULT false,
          sent_via_email BOOLEAN DEFAULT false,
          sent_via_sms BOOLEAN DEFAULT false,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ notifications table');
    
    // 10. Audit Logs Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID REFERENCES users(id),
          action VARCHAR(100) NOT NULL,
          table_name VARCHAR(50),
          record_id UUID,
          old_values JSONB,
          new_values JSONB,
          ip_address VARCHAR(45),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ audit_logs table');
    
    // Create indexes
    console.log('📝 Creating indexes...');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_number ON customers(customer_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_meter ON customers(meter_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bills_customer ON bills(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bills_cycle ON bills(billing_cycle_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bills_status ON bills(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_bill ON payments(bill_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_meter_readings_customer ON meter_readings(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_customer ON notifications(customer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)`);
    console.log('✅ Indexes created');
    
    // Insert default admin user (ignore if exists)
    console.log('📝 Inserting default data...');
    try {
      await client.query(`
        INSERT INTO users (username, email, password_hash, full_name, role)
        VALUES ('admin', 'admin@waterbilling.com', '$2a$10$N9qo8uLOickgx2ZMRZoMye1J4G3QhqNqZFl8W8J8K3mXwP8v8K8W0G', 'System Administrator', 'admin')
      `);
      console.log('✅ Default admin user created');
    } catch (e) {
      if (e.code === '23505') {
        console.log('ℹ️ Admin user already exists');
      } else throw e;
    }
    
    // Insert default billing cycles if none exist
    try {
      const cycleCount = await client.query('SELECT COUNT(*) FROM billing_cycles');
      if (parseInt(cycleCount.rows[0].count) === 0) {
        const currentYear = new Date().getFullYear();
        const months = [
          { month: 1, name: 'Januari' },
          { month: 2, name: 'Februari' },
          { month: 3, name: 'Maret' },
          { month: 4, name: 'April' },
          { month: 5, name: 'Mei' },
          { month: 6, name: 'Juni' },
          { month: 7, name: 'Juli' },
          { month: 8, name: 'Agustus' },
          { month: 9, name: 'September' },
          { month: 10, name: 'Oktober' },
          { month: 11, name: 'November' },
          { month: 12, name: 'Desember' },
        ];
        
        for (const m of months) {
          const startDate = `${currentYear}-${String(m.month).padStart(2, '0')}-01`;
          const endDate = `${currentYear}-${String(m.month).padStart(2, '0')}-28`;
          await client.query(
            `INSERT INTO billing_cycles (cycle_name, start_date, end_date, status)
             VALUES ($1, $2, $3, 'closed')`,
            [`${m.name} ${currentYear}`, startDate, endDate]
          );
        }
        console.log('✅ Default billing cycles created');
      }
    } catch (e) {
      console.log('ℹ️ Billing cycles already exist or error:', e.message);
    }
    
    // Insert default tariffs (ignore if exists)
    try {
      await client.query(`
        INSERT INTO tariffs (tariff_name, customer_type, min_usage_cubic, price_per_cubic, admin_fee, late_fee, effective_date, is_active)
        VALUES 
        ('Residential Tier 1', 'residential', 0, 5000, 10000, 5000, '2024-01-01', true),
        ('Residential Tier 2', 'residential', 10, 6500, 10000, 5000, '2024-01-01', true),
        ('Commercial Tier 1', 'commercial', 0, 8000, 15000, 10000, '2024-01-01', true),
        ('Commercial Tier 2', 'commercial', 50, 10000, 15000, 10000, '2024-01-01', true),
        ('Industrial Tier 1', 'industrial', 0, 12000, 25000, 15000, '2024-01-01', true)
      `);
      console.log('✅ Default tariffs created');
    } catch (e) {
      if (e.code === '23505') {
        console.log('ℹ️ Tariffs already exist');
      } else throw e;
    }
    
    // Verify tables
    const result = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('\n📋 Database tables:');
    result.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
    
    client.release();
    await pool.end();
    console.log('\n🎉 Database migration complete!');
    
  } catch (error) {
    console.error('❌ Error during migration:', error.message);
    await pool.end();
    process.exit(1);
  }
}

migrate();