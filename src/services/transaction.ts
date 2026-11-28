import type { DbOrder, DbProduct, DbUser } from '../types/db'

export interface PurchaseResult {
  success: boolean
  order?: DbOrder
  products?: DbProduct[]
  error?: 'insufficient_balance' | 'insufficient_stock' | 'db_error'
}

export interface DepositResult {
  success: boolean
  newBalance?: number
  error?: 'already_processed' | 'expired' | 'not_found' | 'db_error'
}

export class TransactionService {
  /**
   * Atomic purchase: check balance → deduct → mark products sold → create order + order_items + transaction.
   */
  async executePurchase(
    db: D1Database,
    userId: number,
    categoryId: number,
    quantity: number,
    unitPrice: number
  ): Promise<PurchaseResult> {
    const totalAmount = quantity * unitPrice
    const now = new Date().toISOString()

    const [userResult, productsResult] = await Promise.all([
      db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<DbUser>(),
      db
        .prepare(
          "SELECT * FROM products WHERE type_id = ? AND status = 'available' ORDER BY created_at ASC LIMIT ?"
        )
        .bind(categoryId, quantity)
        .all<DbProduct>(),
    ])

    if (!userResult) {
      return { success: false, error: 'db_error' }
    }

    if (userResult.balance < totalAmount) {
      return { success: false, error: 'insufficient_balance' }
    }

    const availableProducts = productsResult.results
    if (availableProducts.length < quantity) {
      return { success: false, error: 'insufficient_stock' }
    }

    const balanceBefore = userResult.balance
    const balanceAfter = balanceBefore - totalAmount

    let orderId: number
    try {
      const orderInsert = await db
        .prepare(
          'INSERT INTO orders (user_id, product_type_id, quantity, total_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
        )
        .bind(userId, categoryId, quantity, totalAmount, 'completed', now)
        .first<{ id: number }>()

      if (!orderInsert) {
        return { success: false, error: 'db_error' }
      }

      orderId = orderInsert.id
    } catch {
      return { success: false, error: 'db_error' }
    }

    const stmts: D1PreparedStatement[] = []

    stmts.push(
      db
        .prepare('UPDATE users SET balance = ?, updated_at = ? WHERE id = ? AND balance >= ?')
        .bind(balanceAfter, now, userId, totalAmount)
    )

    for (const product of availableProducts) {
      stmts.push(
        db
          .prepare(
            "UPDATE products SET status = 'sold', buyer_id = ?, order_id = ?, sold_at = ? WHERE id = ? AND status = 'available'"
          )
          .bind(userId, orderId, now, product.id)
      )
    }

    for (const product of availableProducts) {
      stmts.push(
        db
          .prepare(
            'INSERT INTO order_items (order_id, product_id, created_at) VALUES (?, ?, ?)'
          )
          .bind(orderId, product.id, now)
      )
    }

    stmts.push(
      db
        .prepare(
          'INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          userId,
          'purchase',
          -totalAmount,
          balanceBefore,
          balanceAfter,
          'order',
          orderId,
          `Mua ${quantity} sản phẩm`,
          'success',
          now
        )
    )

    let results: D1Result[]
    try {
      results = await db.batch(stmts)
    } catch {
      await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run().catch(() => {})
      return { success: false, error: 'db_error' }
    }

    if (results[0].meta.changes === 0) {
      await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run().catch(() => {})
      return { success: false, error: 'insufficient_balance' }
    }

    for (let i = 1; i <= availableProducts.length; i++) {
      if (results[i].meta.changes === 0) {
        await db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(orderId).run().catch(() => {})
        await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run().catch(() => {})
        return { success: false, error: 'insufficient_stock' }
      }
    }

    const order = await db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .bind(orderId)
      .first<DbOrder>()

    return {
      success: true,
      order: order ?? undefined,
      products: availableProducts,
    }
  }

  /**
   * Deposit processing.
   * Claim the pending deposit before crediting the user's balance.
   */
  async executeDeposit(
    db: D1Database,
    depositId: number,
    userId: number,
    amount: number,
    sepayTxId: string
  ): Promise<DepositResult> {
    const now = new Date().toISOString()

    const [userResult, depositResult] = await Promise.all([
      db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<DbUser>(),
      db
        .prepare('SELECT status FROM deposits WHERE id = ? AND user_id = ?')
        .bind(depositId, userId)
        .first<{ status: string }>(),
    ])

    if (!userResult) {
      return { success: false, error: 'db_error' }
    }

    if (!depositResult) {
      return { success: false, error: 'not_found' }
    }

    if (depositResult.status === 'completed') {
      return { success: false, error: 'already_processed' }
    }

    if (depositResult.status === 'expired') {
      return { success: false, error: 'expired' }
    }

    if (depositResult.status !== 'pending') {
      return { success: false, error: 'not_found' }
    }

    const balanceBefore = userResult.balance
    const balanceAfter = balanceBefore + amount

    const stmts: D1PreparedStatement[] = [
      // Claim deposit only once
      db
        .prepare(
          "UPDATE deposits SET status = 'completed', sepay_transaction_id = ?, completed_at = ? WHERE id = ? AND user_id = ? AND status = 'pending' AND sepay_transaction_id IS NULL"
        )
        .bind(sepayTxId, now, depositId, userId),

      // Credit balance only if this transaction successfully claimed the deposit
      db
        .prepare(
          'UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM deposits WHERE id = ? AND user_id = ? AND status = \'completed\' AND sepay_transaction_id = ?)'
        )
        .bind(amount, now, userId, depositId, userId, sepayTxId),

      // Insert history only when the deposit was claimed
      db
        .prepare(
          "INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, status, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM deposits WHERE id = ? AND user_id = ? AND status = 'completed' AND sepay_transaction_id = ?)"
        )
        .bind(
          userId,
          'deposit',
          amount,
          balanceBefore,
          balanceAfter,
          'deposit',
          depositId,
          `Nạp ${amount.toLocaleString('vi-VN')}đ`,
          'success',
          now,
          depositId,
          userId,
          sepayTxId
        ),
    ]

    let results: D1Result[]
    try {
      results = await db.batch(stmts)
    } catch (err) {
      console.error('[Deposit] D1 batch failed:', err)
      return { success: false, error: 'db_error' }
    }

    if (results[0].meta.changes === 0) {
      return { success: false, error: 'already_processed' }
    }

    if (results[1].meta.changes === 0) {
      console.error('[Deposit] Deposit claimed but balance update failed:', depositId)
      return { success: false, error: 'db_error' }
    }

    return {
      success: true,
      newBalance: balanceAfter,
    }
  }
}

export const transactionService = new TransactionService()


