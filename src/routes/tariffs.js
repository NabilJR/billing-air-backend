const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

// Get all tariffs
router.get('/', async (req, res) => {
  const pool = req.app.get('db');
  const { customer_type = '', active = '' } = req.query;

  try {
    let query = 'SELECT * FROM tariffs WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (customer_type) {
      query += ` AND customer_type = $${paramIndex}`;
      params.push(customer_type);
      paramIndex++;
    }

    if (active !== '') {
      query += ` AND is_active = $${paramIndex}`;
      params.push(active === 'true');
    }

    query += ' ORDER BY customer_type, min_usage_cubic';

    const result = await pool.query(query, params);
    res.json({ tariffs: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get tariff by ID
router.get('/:id', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      'SELECT * FROM tariffs WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tariff not found' });
    }

    res.json({ tariff: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Create new tariff
router.post('/', [
  body('tariff_name').notEmpty().trim(),
  body('customer_type').isIn(['residential', 'commercial', 'industrial']),
  body('min_usage_cubic').isNumeric(),
  body('price_per_cubic').isNumeric(),
  body('effective_date').isISO8601()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const pool = req.app.get('db');
  const { tariff_name, customer_type, min_usage_cubic, price_per_cubic, admin_fee = 0, late_fee = 0, effective_date, end_date } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO tariffs (tariff_name, customer_type, min_usage_cubic, price_per_cubic, admin_fee, late_fee, effective_date, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tariff_name, customer_type, min_usage_cubic, price_per_cubic, admin_fee, late_fee, effective_date, end_date]
    );

    res.status(201).json({ tariff: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update tariff
router.put('/:id', async (req, res) => {
  const pool = req.app.get('db');
  const { tariff_name, min_usage_cubic, price_per_cubic, admin_fee, late_fee, end_date, is_active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE tariffs 
       SET tariff_name = COALESCE($1, tariff_name),
           min_usage_cubic = COALESCE($2, min_usage_cubic),
           price_per_cubic = COALESCE($3, price_per_cubic),
           admin_fee = COALESCE($4, admin_fee),
           late_fee = COALESCE($5, late_fee),
           end_date = COALESCE($6, end_date),
           is_active = COALESCE($7, is_active)
       WHERE id = $8 RETURNING *`,
      [tariff_name, min_usage_cubic, price_per_cubic, admin_fee, late_fee, end_date, is_active, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tariff not found' });
    }

    res.json({ tariff: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete tariff
router.delete('/:id', async (req, res) => {
  const pool = req.app.get('db');

  try {
    const result = await pool.query(
      'DELETE FROM tariffs WHERE id = $1 AND is_active = true RETURNING id',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Tariff not found or cannot be deleted (already in use)' });
    }

    res.json({ message: 'Tariff deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
