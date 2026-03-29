const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

// Get all bills
router.get('/', async (req, res) => {
  const pool = req.app.get('db');
  const { page = 1, limit = 10, status = '', customer_id = '', search = '' } = req.query;
  const offset = (page - 1) * limit;

  try {
    let query = `
      SELECT b.*, c.name as customer_name, c.customer_number, c.meter_number, bc.cycle_name
      FROM bills b
      JOIN customers c ON b.customer_id = c.id
      JOIN billing_cycles bc ON b.billing_cycle_id = bc.id
      WHERE 1=1
    `;
    let countQuery = 'SELECT COUNT(*) FROM bills b JOIN customers c ON b.customer_id = c.id WHERE 1=1';
    const params = [];
    const countParams = [];

    // Search by customer name or bill number
    if (search) {
      const paramNum = params.length + 1;
      query += ` AND (c.name ILIKE $${paramNum} OR b.bill_number ILIKE $${paramNum})`;
      countQuery += ` AND (c.name ILIKE $${paramNum} OR b.bill_number ILIKE $${paramNum})`;
      params.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    if (status) {
      const paramNum = params.length + 1;
      query += ` AND b.status = $${paramNum}`;
      countQuery += ` AND b.status = $${paramNum}`;
      params.push(status);
      countParams.push(status);
    }

    if (customer_id) {
      const paramNum = params.length + 1;
      query += ` AND b.customer_id = $${paramNum}`;
      countQuery += ` AND b.customer_id = $${paramNum}`;
      params.push(customer_id);
      countParams.push(customer_id);
    }

    // Add LIMIT and OFFSET as literal values (not parameterized)
    query += ` ORDER BY b.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;

    const [bills, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams)
    ]);

    res.json({
      bills: bills.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get bill by ID
router.get('/:id', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      `SELECT b.*, c.name as customer_name, c.customer_number, c.meter_number, c.address, 
              bc.cycle_name, t.tariff_name, t.price_per_cubic
       FROM bills b
       JOIN customers c ON b.customer_id = c.id
       JOIN billing_cycles bc ON b.billing_cycle_id = bc.id
       LEFT JOIN tariffs t ON b.tariff_id = t.id
       WHERE b.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    res.json({ bill: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new bill (manual)
router.post('/', [
  body('customer_id').notEmpty(),
  body('billing_cycle_id').notEmpty(),
  body('previous_reading').isNumeric(),
  body('current_reading').isNumeric(),
  body('due_date').isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const pool = req.app.get('db');
  const { customer_id, billing_cycle_id, previous_reading, current_reading, due_date, other_charges = 0 } = req.body;

  try {
    // Get customer info
    const customerResult = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customer_id]
    );

    if (customerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const customer = customerResult.rows[0];

    // Get the latest bill for this customer to get previous reading
    const lastBillResult = await pool.query(
      `SELECT current_reading FROM bills 
       WHERE customer_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [customer_id]
    );

    // Calculate usage
    const previousReading = lastBillResult.rows.length > 0 ? parseFloat(lastBillResult.rows[0].current_reading) : parseFloat(previous_reading || 0);
    const currentReadingVal = parseFloat(current_reading);
    const usage_cubic = currentReadingVal - previousReading;
    
    if (usage_cubic < 0) {
      return res.status(400).json({ error: 'Pembacaan meter saat ini harus lebih besar dari pembacaan sebelumnya' });
    }

    // Get applicable tariff
    const tariffResult = await pool.query(
      `SELECT * FROM tariffs 
       WHERE customer_type = $1 AND is_active = true 
       AND effective_date <= $2 
       ORDER BY min_usage_cubic DESC 
       LIMIT 1`,
      [customer.customer_type, due_date]
    );

    if (tariffResult.rows.length === 0) {
      return res.status(400).json({ error: 'No applicable tariff found' });
    }

    const tariff = tariffResult.rows[0];

    // Calculate charges
    let water_charge = 0;
    let remaining_usage = usage_cubic;

    // Get all tariffs for this customer type sorted by min usage (descending for tier calculation)
    const allTariffs = await pool.query(
      `SELECT * FROM tariffs 
       WHERE customer_type = $1 AND is_active = true 
       AND effective_date <= $2 
       ORDER BY min_usage_cubic DESC`,
      [customer.customer_type, due_date]
    );

    for (const t of allTariffs.rows) {
      const nextTariff = allTariffs.rows[allTariffs.rows.indexOf(t) + 1];
      const maxUsage = nextTariff ? nextTariff.min_usage_cubic - t.min_usage_cubic : remaining_usage;
      const applicableUsage = Math.min(remaining_usage, maxUsage || remaining_usage);
      
      water_charge += applicableUsage * parseFloat(t.price_per_cubic);
      remaining_usage -= applicableUsage;
      
      if (remaining_usage <= 0) break;
    }

    const admin_fee = parseFloat(tariff.admin_fee);
    const late_fee = 0; // Late fee will be added when payment is made after due_date
    const total_amount = water_charge + admin_fee + parseFloat(other_charges);

    // Generate bill number
    const billCount = await pool.query('SELECT COUNT(*) FROM bills');
    const billNumber = `BILL-${Date.now()}-${parseInt(billCount.rows[0].count) + 1}`;

    const result = await pool.query(
      `INSERT INTO bills (bill_number, customer_id, billing_cycle_id, previous_reading, current_reading, 
                          usage_cubic, tariff_id, water_charge, admin_fee, late_fee, other_charges, total_amount, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [billNumber, customer_id, billing_cycle_id, previous_reading, current_reading, usage_cubic,
       tariff.id, water_charge, admin_fee, late_fee, other_charges, total_amount, due_date]
    );

    // Update customer meter reading
    await pool.query(
      'UPDATE customers SET meter_reading = $1, updated_at = NOW() WHERE id = $2',
      [current_reading, customer_id]
    );

    res.status(201).json({ bill: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update bill status
router.patch('/:id', async (req, res) => {
  const pool = req.app.get('db');
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE bills SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    res.json({ bill: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete bill
router.delete('/:id', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      'DELETE FROM bills WHERE id = $1 AND status = \'unpaid\' RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Bill not found or cannot be deleted (already paid)' });
    }

    res.json({ message: 'Bill deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get overdue bills
router.get('/overdue/list', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      `SELECT b.*, c.name as customer_name, c.customer_number, c.email, c.phone
       FROM bills b
       JOIN customers c ON b.customer_id = c.id
       WHERE b.status = 'unpaid' AND b.due_date < CURRENT_DATE
       ORDER BY b.due_date ASC`
    );

    res.json({ bills: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get latest bill by customer ID
router.get('/customer/:customerId/latest', async (req, res) => {
  const pool = req.app.get('db');
  const { customerId } = req.params;

  try {
    const result = await pool.query(
      `SELECT * FROM bills 
       WHERE customer_id = $1 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [customerId]
    );

    if (result.rows.length === 0) {
      return res.json({ bill: null });
    }

    res.json({ bill: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
