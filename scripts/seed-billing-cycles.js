const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_45wdkqmhlEvj@ep-cold-leaf-a1294r0g-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
});

// Generate billing cycles dynamically based on current date
function generateBillingCycles() {
  const cycles = [];
  const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  
  // Generate 2 years back and 2 years forward from current date
  const startYear = currentYear - 2;
  const endYear = currentYear + 2;
  
  for (let year = startYear; year <= endYear; year++) {
    for (let month = 0; month < 12; month++) {
      const startDate = new Date(year, month, 1);
      const endDate = new Date(year, month + 1, 0); // Last day of month
      
      // Determine if period should be open or closed
      // Current month and future months are open
      const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const isCurrentOrFuture = startDate >= periodStart;
      
      cycles.push({
        cycle_name: `${monthNames[month]} ${year}`,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
        meter_reading_deadline: new Date(year, month + 1, 5).toISOString().split('T')[0],
        payment_deadline: new Date(year, month + 1, 15).toISOString().split('T')[0],
        status: isCurrentOrFuture ? 'open' : 'closed',
      });
    }
  }
  return cycles;
}

async function seedBillingCycles() {
  try {
    // Delete existing data first
    await pool.query('DELETE FROM billing_cycles');
    console.log('Cleared existing billing cycles...');
    
    // Generate cycles dynamically
    const billingCycles = generateBillingCycles();
    
    // Get current year info
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    
    console.log(`Generating periods: ${currentYear - 2} to ${currentYear + 2} (dynamic based on current date)`);
    
    // Insert in batches
    for (const cycle of billingCycles) {
      await pool.query(
        `INSERT INTO billing_cycles (cycle_name, start_date, end_date, meter_reading_deadline, payment_deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [cycle.cycle_name, cycle.start_date, cycle.end_date, cycle.meter_reading_deadline, cycle.payment_deadline, cycle.status]
      );
    }

    console.log(`\nSuccessfully seeded ${billingCycles.length} billing cycles!`);
    
    // Show summary
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'closed') as closed_count
      FROM billing_cycles
    `);
    
    console.log(`\nTotal: ${result.rows[0].total} periode`);
    console.log(`Open: ${result.rows[0].open_count} | Closed: ${result.rows[0].closed_count}`);
    
    // Show current period
    const currentPeriod = billingCycles.find(c => 
      c.cycle_name === `${monthNames[currentMonth]} ${currentYear}`
    );
    console.log(`\nPeriode saat ini: ${currentPeriod?.cycle_name || 'N/A'}`);
    
    // Show available periods
    const openPeriods = billingCycles.filter(c => c.status === 'open').slice(0, 6);
    console.log('\nPeriode yang tersedia (open):');
    openPeriods.forEach(cycle => {
      console.log(`- ${cycle.cycle_name}`);
    });

    await pool.end();
  } catch (error) {
    console.error('Error seeding billing cycles:', error);
    await pool.end();
    process.exit(1);
  }
}

seedBillingCycles();