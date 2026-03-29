const express = require('express');
const router = express.Router();

// Get dashboard statistics
router.get('/stats', async (req, res) => {
  const pool = req.app.get('db');
  const { year, month } = req.query;

  // Use provided year/month or default to current
  const selectedYear = year || new Date().getFullYear().toString();
  const selectedMonth = month || (new Date().getMonth() + 1).toString().padStart(2, '0');
  const period = `${selectedYear}-${selectedMonth}`;

  console.log('Dashboard Stats - Period:', period);

  try {
    // Total customers
    const customerCount = await pool.query(
      "SELECT COUNT(*) FROM customers WHERE status = 'active'"
    );
    console.log('Total customers:', customerCount.rows[0].count);

    // Total bills for selected period
    const billsThisPeriod = await pool.query(
      `SELECT COUNT(*) FROM bills WHERE status != 'cancelled'`
    );
    console.log('Total bills (all):', billsThisPeriod.rows[0].count);

    // Total bills for period
    const billsPeriod = await pool.query(
      `SELECT COALESCE(SUM(a.total_amount), 0) as total from bills a 
        JOIN billing_cycles b 
        ON b.id = a.billing_cycle_id
      WHERE TO_CHAR(start_date, 'YYYY-MM') = $1
      GROUP BY
      b.start_date`,
      [period]
    );
    console.log('Bills this period:', billsPeriod.rows[0].total);

    // Total revenue - get from all payments with confirmed status
    const revenueResult = await pool.query(
      `SELECT COALESCE(SUM(payment_amount), 0) as total FROM payments WHERE status = 'completed'`
    );
    console.log('Revenue (all confirmed):', revenueResult.rows[0].total);

    // Revenue this period - use 'completed' status
    // Debug: show all payments with completed status and their dates
    const allCompletedPayments = await pool.query(
      `SELECT id, payment_amount, status, created_at, confirmed_at, 
       TO_CHAR(COALESCE(confirmed_at, created_at), 'YYYY-MM') as payment_month
       FROM payments WHERE status = 'completed'`
    );
    console.log('All completed payments:', allCompletedPayments.rows);
    
    // Revenue this period
    const revenuePeriod = await pool.query(
      `SELECT COALESCE(SUM(payment_amount), 0) as total 
       FROM payments 
       WHERE status = 'completed' 
       AND TO_CHAR(COALESCE(confirmed_at, created_at), 'YYYY-MM') = $1`,
      [period]
    );
    console.log('Revenue this period (' + period + '):', revenuePeriod.rows[0].total);

    // Unpaid bills count
    const unpaidBills = await pool.query(
      "SELECT COUNT(*) FROM bills WHERE status = 'unpaid'"
    );
    console.log('Unpaid bills:', unpaidBills.rows[0].count);

    // Overdue bills
    const overdueBills = await pool.query(
      `SELECT COUNT(*) FROM bills 
       WHERE status = 'unpaid' AND due_date < CURRENT_DATE`
    );
    console.log('Overdue bills:', overdueBills.rows[0].count);

    // Pending payments
    const sisaTagihan = await pool.query(
      `SELECT SUM(total_sisa) sisa FROM
        (SELECT (a.total_amount - a.paid_amount) as total_sisa, a.bill_number FROM bills a
        JOIN billing_cycles b 
        ON b.id = a.billing_cycle_id
      WHERE TO_CHAR(start_date, 'YYYY-MM') = $1)`,
      [period]
    );
    console.log('Pending payments:', sisaTagihan.rows[0].sisa);

    res.json({
      stats: {
        total_customers: parseInt(customerCount.rows[0].count),
        bills_this_month: parseInt(billsPeriod.rows[0].total),
        revenue_this_month: parseFloat(revenuePeriod.rows[0].total),
        unpaid_bills: parseInt(unpaidBills.rows[0].count),
        overdue_bills: parseInt(overdueBills.rows[0].count),
        sisa_tagih: parseInt(sisaTagihan.rows[0].sisa),
        selected_period: period
      }
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue chart data
router.get('/revenue-chart', async (req, res) => {
  const pool = req.app.get('db');
  const { months = 6 } = req.query;

  try {
    const result = await pool.query(
      `SELECT TO_CHAR(confirmed_at, 'YYYY-MM') as month, 
              SUM(payment_amount) as total
       FROM payments 
       WHERE status = 'confirmed' 
       AND confirmed_at >= DATE_TRUNC('month', NOW() - INTERVAL '${months} months')
       GROUP BY TO_CHAR(confirmed_at, 'YYYY-MM')
       ORDER BY month`
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get customer type distribution
router.get('/customer-distribution', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      `SELECT customer_type, COUNT(*) as count 
       FROM customers 
       WHERE status = 'active'
       GROUP BY customer_type`
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent bills
router.get('/recent-bills', async (req, res) => {
  const pool = req.app.get('db');
  const { limit = 10 } = req.query;

  try {
    const result = await pool.query(
      `SELECT b.*, c.name as customer_name, c.customer_number
       FROM bills b
       JOIN customers c ON b.customer_id = c.id
       ORDER BY b.created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ bills: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get recent payments
router.get('/recent-payments', async (req, res) => {
  const pool = req.app.get('db');
  const { limit = 10 } = req.query;

  try {
    const result = await pool.query(
      `SELECT p.*, c.name as customer_name, c.customer_number, b.bill_number
       FROM payments p
       JOIN customers c ON p.customer_id = c.id
       JOIN bills b ON p.bill_id = b.id
       ORDER BY p.created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ payments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get billing cycles
router.get('/billing-cycles', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      'SELECT * FROM billing_cycles ORDER BY start_date DESC'
    );

    res.json({ cycles: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create billing cycle
router.post('/billing-cycles', async (req, res) => {
  const pool = req.app.get('db');
  const { cycle_name, start_date, end_date, meter_reading_deadline, payment_deadline } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO billing_cycles (cycle_name, start_date, end_date, meter_reading_deadline, payment_deadline)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [cycle_name, start_date, end_date, meter_reading_deadline, payment_deadline]
    );

    res.status(201).json({ cycle: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
