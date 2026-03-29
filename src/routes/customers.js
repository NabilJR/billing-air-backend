const express = require('express');
const router = express.Router();
const { authMiddleware, requireRole } = require('../middleware/auth');

// Apply auth middleware to all customer routes
router.use(authMiddleware);

// Get all customers
router.get('/', async (req, res) => {
  const pool = req.app.get('db');
  const { page = 1, limit = 10, status = '', search = '' } = req.query;
  const offset = (page - 1) * limit;

  try {
    let query = `
      SELECT c.*, 
             (SELECT COUNT(*) FROM bills WHERE customer_id = c.id) as total_bills,
             (SELECT COUNT(*) FROM bills WHERE customer_id = c.id AND status = 'unpaid') as unpaid_bills
      FROM customers c
      WHERE 1=1
    `;
    let countQuery = 'SELECT COUNT(*) FROM customers c WHERE 1=1';
    const params = [];
    const countParams = [];

    // Search by name, customer_number, or meter_number
    if (search) {
      const paramNum = params.length + 1;
      query += ` AND (c.name ILIKE $${paramNum} OR c.customer_number ILIKE $${paramNum} OR c.meter_number ILIKE $${paramNum})`;
      countQuery += ` AND (c.name ILIKE $${paramNum} OR c.customer_number ILIKE $${paramNum} OR c.meter_number ILIKE $${paramNum})`;
      params.push(`%${search}%`);
      countParams.push(`%${search}%`);
    }

    if (status) {
      const paramNum = params.length + 1;
      query += ` AND c.status = $${paramNum}`;
      countQuery += ` AND c.status = $${paramNum}`;
      params.push(status);
      countParams.push(status);
    }

    query += ` ORDER BY c.created_at DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;

    const [customers, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams)
    ]);

    res.json({
      customers: customers.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get customer by ID
router.get('/:id', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      `SELECT c.*, 
              t.tariff_name, t.price_per_cubic,
              (SELECT COUNT(*) FROM bills WHERE customer_id = c.id) as total_bills,
              (SELECT COUNT(*) FROM bills WHERE customer_id = c.id AND status = 'paid') as paid_bills,
              (SELECT COUNT(*) FROM bills WHERE customer_id = c.id AND status = 'unpaid') as unpaid_bills
       FROM customers c
       LEFT JOIN tariffs t ON t.customer_type = c.customer_type AND t.is_active = true
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Get recent bills
    const billsResult = await pool.query(
      `SELECT * FROM bills WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [req.params.id]
    );

    res.json({ 
      customer: result.rows[0],
      recent_bills: billsResult.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new customer
router.post('/', [
  requireRole('admin', 'manager', 'staff')
], async (req, res) => {
  const pool = req.app.get('db');
  const { customer_number, name, email, phone, address, district, city, postal_code, meter_number, customer_type, meter_reading } = req.body;

  try {
    // Generate customer number if not provided
    const customerNum = customer_number || `CUST-${Date.now()}`;

    // Generate meter number if not provided
    const meterNum = meter_number || `MTR-${Date.now()}`;

    const result = await pool.query(
      `INSERT INTO customers (customer_number, name, email, phone, address, district, city, postal_code, meter_number, customer_type, meter_reading)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [customerNum, name, email, phone, address, district, city, postal_code, meterNum, customer_type || 'residential', meter_reading || 0]
    );

    res.status(201).json({ customer: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Customer number or meter number already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update customer
router.put('/:id', [
  requireRole('admin', 'manager', 'staff')
], async (req, res) => {
  const pool = req.app.get('db');
  const { name, email, phone, address, district, city, postal_code, meter_number, customer_type, meter_reading, status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE customers 
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           phone = COALESCE($3, phone),
           address = COALESCE($4, address),
           district = COALESCE($5, district),
           city = COALESCE($6, city),
           postal_code = COALESCE($7, postal_code),
           meter_number = COALESCE($8, meter_number),
           customer_type = COALESCE($9, customer_type),
           meter_reading = COALESCE($10, meter_reading),
           status = COALESCE($11, status),
           updated_at = NOW()
       WHERE id = $12 RETURNING *`,
      [name, email, phone, address, district, city, postal_code, meter_number, customer_type, meter_reading, status, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ customer: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Customer number or meter number already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete customer (only if no unpaid bills)
router.delete('/:id', [
  requireRole('admin')
], async (req, res) => {
  const pool = req.app.get('db');

  try {
    // Check for unpaid bills
    const billsCheck = await pool.query(
      `SELECT COUNT(*) FROM bills WHERE customer_id = $1 AND status IN ('unpaid', 'partial')`,
      [req.params.id]
    );

    if (parseInt(billsCheck.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete customer with unpaid bills' });
    }

    const result = await pool.query(
      'DELETE FROM customers WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ message: 'Customer deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Search customers
router.get('/search/q', async (req, res) => {
  const pool = req.app.get('db');
  const { q } = req.query;

  try {
    const result = await pool.query(
      `SELECT id, customer_number, name, meter_number 
       FROM customers 
       WHERE status = 'active' 
       AND (name ILIKE $1 OR customer_number ILIKE $1 OR meter_number ILIKE $1)
       LIMIT 20`,
      [`%${q}%`]
    );

    res.json({ customers: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
