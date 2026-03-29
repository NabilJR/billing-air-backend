const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

// Get all payments
router.get('/', async (req, res) => {
  const pool = req.app.get('db');
  const { page = 1, limit = 10, status = '', customer_id = '', search = '' } = req.query;
  const offset = (page - 1) * limit;

  try {
    let query = `
      SELECT p.*, c.name as customer_name, c.customer_number, b.bill_number
      FROM payments p
      JOIN customers c ON p.customer_id = c.id
      JOIN bills b ON p.bill_id = b.id
      WHERE 1=1
    `;
    let countQuery = `
      SELECT COUNT(*) FROM payments p
      JOIN customers c ON p.customer_id = c.id
      JOIN bills b ON p.bill_id = b.id
      WHERE 1=1
    `;
    const params = [];
    const countParams = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND p.status = $${paramIndex}`;
      countQuery += ` AND p.status = $${paramIndex}`;
      params.push(status);
      countParams.push(status);
      paramIndex++;
    }

    if (customer_id) {
      query += ` AND p.customer_id = $${paramIndex}`;
      countQuery += ` AND p.customer_id = $${paramIndex}`;
      params.push(customer_id);
      countParams.push(customer_id);
      paramIndex++;
    }

    if (search && String(search).trim()) {
      const searchStr = `%${String(search).trim()}%`;
      query += ` AND (p.payment_number::text ILIKE $${paramIndex} OR c.name::text ILIKE $${paramIndex} OR c.customer_number::text ILIKE $${paramIndex} OR b.bill_number::text ILIKE $${paramIndex})`;
      countQuery += ` AND (p.payment_number::text ILIKE $${paramIndex} OR c.name::text ILIKE $${paramIndex} OR c.customer_number::text ILIKE $${paramIndex} OR b.bill_number::text ILIKE $${paramIndex})`;
      params.push(searchStr);
      countParams.push(searchStr);
      paramIndex++;
    }

    const limitParam = paramIndex;
    const offsetParam = paramIndex + 1;
    query += ` ORDER BY p.created_at DESC LIMIT $${limitParam} OFFSET $${offsetParam}`;
    params.push(Number(limit), Number(offset));

    const [payments, countResult] = await Promise.all([
      pool.query(query, params),
      pool.query(countQuery, countParams)
    ]);

    res.json({
      payments: payments.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page),
      totalPages: Math.ceil(countResult.rows[0].count / limit)
    });
  } catch (err) {
    console.error('Error fetching payments:', err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

// Create payment
router.post('/', [
  body('bill_id').notEmpty(),
  body('payment_amount').isFloat({ min: 0 }),
  body('payment_method').isIn(['cash', 'bank_transfer', 'e_wallet', 'credit_card'])
], async (req, res) => {
  const pool = req.app.get('db');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { bill_id, payment_amount, payment_method, notes, transaction_id, bank_name, account_number } = req.body;
  const amount = parseFloat(payment_amount);

  try {
    // Get bill details
    const billResult = await pool.query('SELECT * FROM bills WHERE id = $1', [bill_id]);
    if (billResult.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const bill = billResult.rows[0];
    const paymentNumber = `PAY-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

    // Insert payment
    const paymentResult = await pool.query(
      `INSERT INTO payments (payment_number, bill_id, customer_id, payment_amount, payment_method, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [paymentNumber, bill_id, bill.customer_id, amount, payment_method, 'completed']
    );

    // Update bill status and paid_amount based on payment amount
    const newPaidAmount = (parseFloat(bill.paid_amount) || 0) + amount;
    let newBillStatus = 'paid';
    if (newPaidAmount < bill.total_amount) {
      newBillStatus = 'partial';
    }

    await pool.query(
      'UPDATE bills SET status = $1, paid_amount = $2 WHERE id = $3',
      [newBillStatus, newPaidAmount, bill_id]
    );

    res.status(201).json(paymentResult.rows[0]);
  } catch (err) {
    console.error('Error creating payment:', err);
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Get payment by ID
router.get('/:id', async (req, res) => {
  const pool = req.app.get('db');
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT p.*, c.name as customer_name, c.customer_number, b.bill_number
       FROM payments p
       JOIN customers c ON p.customer_id = c.id
       JOIN bills b ON p.bill_id = b.id
       WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching payment:', err);
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// Update payment status
router.patch('/:id', [
  body('status').isIn(['pending', 'completed', 'failed', 'refunded'])
], async (req, res) => {
  const pool = req.app.get('db');
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { id } = req.params;
  const { status } = req.body;

  try {
    const result = await pool.query(
      'UPDATE payments SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // If payment is completed, update bill status
    if (status === 'completed') {
      const payment = result.rows[0];
      const billResult = await pool.query('SELECT * FROM bills WHERE id = $1', [payment.bill_id]);
      if (billResult.rows.length > 0) {
        const bill = billResult.rows[0];
        let newStatus = 'paid';
        if (payment.payment_amount < bill.total_amount) {
          newStatus = 'partial';
        }
        await pool.query('UPDATE bills SET status = $1 WHERE id = $2', [newStatus, payment.bill_id]);
      }
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating payment:', err);
    res.status(500).json({ error: 'Failed to update payment' });
  }
});

// Delete payment
router.delete('/:id', async (req, res) => {
  const pool = req.app.get('db');
  const { id } = req.params;

  try {
    // Get payment first
    const paymentResult = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Delete payment
    await pool.query('DELETE FROM payments WHERE id = $1', [id]);

    // Reset bill status
    await pool.query(
      'UPDATE bills SET status = $1 WHERE id = $2',
      ['unpaid', paymentResult.rows[0].bill_id]
    );

    res.json({ message: 'Payment deleted successfully' });
  } catch (err) {
    console.error('Error deleting payment:', err);
    res.status(500).json({ error: 'Failed to delete payment' });
  }
});

// Get invoice for completed payment
router.get('/:id/invoice', async (req, res) => {
  const pool = req.app.get('db');
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT 
        p.*, 
        c.name as customer_name, 
        c.customer_number, 
        c.address as customer_address,
        c.phone as customer_phone,
        b.bill_number,
        bc.cycle_name,
        bc.start_date as period_start,
        bc.end_date as period_end,
        b.previous_reading,
        b.current_reading,
        b.usage_cubic,
        b.water_charge,
        b.admin_fee,
        b.late_fee,
        b.other_charges,
        b.total_amount as bill_total_amount,
        b.paid_amount,
        b.status as bill_status,
        u.full_name as confirmed_by_name
      FROM payments p
      JOIN customers c ON p.customer_id = c.id
      JOIN bills b ON p.bill_id = b.id
      JOIN billing_cycles bc ON b.billing_cycle_id = bc.id
      LEFT JOIN users u ON p.confirmed_by = u.id
      WHERE p.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = result.rows[0];

    // Only allow invoice for completed payments
    if (payment.status !== 'completed') {
      return res.status(400).json({ error: 'Invoice hanya tersedia untuk pembayaran yang sudah dikonfirmasi' });
    }

    // Calculate remaining amount
    const remainingAmount = parseFloat(payment.bill_total_amount) - parseFloat(payment.paid_amount || payment.payment_amount);

    res.json({
      invoice: {
        invoice_number: `INV-${payment.payment_number}`,
        invoice_date: new Date().toISOString(),
        payment_date: payment.confirmed_at,
        
        // Customer Info
        customer: {
          name: payment.customer_name,
          number: payment.customer_number,
          address: payment.customer_address,
          phone: payment.customer_phone
        },
        
        // Bill Info
        bill: {
          number: payment.bill_number,
          period: payment.cycle_name,
          period_start: payment.period_start,
          period_end: payment.period_end,
          previous_reading: payment.previous_reading,
          current_reading: payment.current_reading,
          usage_cubic: payment.usage_cubic,
          tariff_price: payment.tariff_price
        },
        
        // Payment Info
        payment: {
          number: payment.payment_number,
          method: payment.payment_method,
          amount: payment.payment_amount,
          confirmed_by: payment.confirmed_by_name,
          confirmed_at: payment.confirmed_at
        },
        
        // Cost Breakdown
        charges: {
          water_charge: payment.water_charge,
          admin_fee: payment.admin_fee,
          late_fee: payment.late_fee || 0,
          other_charges: payment.other_charges || 0,
          total_bill: payment.bill_total_amount,
          amount_paid: payment.paid_amount || payment.payment_amount,
          remaining_amount: remainingAmount > 0 ? remainingAmount : 0
        }
      }
    });
  } catch (err) {
    console.error('Error generating invoice:', err);
    res.status(500).json({ error: 'Failed to generate invoice' });
  }
});

module.exports = router;
