import { UnprocessableEntityError } from 'errors';
import database from 'infra/database.js';

const tableNameMap = {
  'user:tabcoin': 'user_tabcoin_operations',
  'user:tabcash': 'user_tabcash_operations',
  'ad:budget': 'ad_tabcash_operations',
  default: 'content_tabcoin_operations',
};

const balanceTypeMap = {
  'content:tabcoin:credit': 'credit',
  'content:tabcoin:debit': 'debit',
  'content:tabcoin:initial': 'initial',
  'ad:budget': 'budget',
};

const sqlFunctionMap = {
  'user:tabcoin': 'get_user_current_tabcoins',
  'user:tabcash': 'get_user_current_tabcash',
  'ad:budget': 'get_ad_current_tabcash',
  default: 'get_content_current_tabcoins',
};

async function findAllByOriginatorId(originatorId, options) {
  const where = Array.isArray(originatorId) ? 'WHERE originator_id = ANY($1)' : 'WHERE originator_id = $1';
  const query = {
    text: `
      SELECT * FROM (
        SELECT id, recipient_id, amount, originator_type, originator_id,
          'user:tabcoin' AS balance_type
        FROM user_tabcoin_operations
        ${where}
      UNION ALL
        SELECT id, recipient_id, amount, originator_type, originator_id,
          'user:tabcash' AS balance_type
        FROM user_tabcash_operations
        ${where}
      UNION ALL
        SELECT id, recipient_id, amount, originator_type, originator_id,
          CONCAT('content:tabcoin:', balance_type) AS balance_type
        FROM content_tabcoin_operations
        ${where}
      ) AS all_operations;
    `,
    values: [originatorId],
  };

  const results = await database.query(query, options);
  return results.rows;
}

async function create({ balanceType, recipientId, amount, originatorType, originatorId }, options = {}) {
  const tableName = tableNameMap[balanceType] || tableNameMap.default;
  const hasBalanceTypeColum = !balanceType.startsWith('user:');
  const totalBalanceFunction = sqlFunctionMap[balanceType] || sqlFunctionMap.default;

  const returning = options.withBalance ? `*, ${totalBalanceFunction}($1) as total` : '*';

  const query = {
    text: `
      INSERT INTO ${tableName}
        (recipient_id, amount, originator_type, originator_id${hasBalanceTypeColum ? ', balance_type' : ''})
      VALUES
        ($1, $2, $3, $4${hasBalanceTypeColum ? ', $5' : ''})
      RETURNING ${returning};
      `,
    values: [recipientId, amount, originatorType, originatorId],
  };

  if (hasBalanceTypeColum) {
    const parsedBalanceType = balanceTypeMap[balanceType] || balanceType;

    query.values.push(parsedBalanceType);
  }

  const results = await database.query(query, options);
  return results.rows[0];
}

async function getContentTabcoinsCreditDebit({ recipientId }, options = {}) {
  const query = {
    text: 'SELECT * FROM get_content_balance_credit_debit($1);',
    values: [recipientId],
  };

  const results = await database.query(query, options);
  return {
    tabcoins: results.rows[0].total_balance,
    tabcoins_credit: results.rows[0].total_credit,
    tabcoins_debit: results.rows[0].total_debit,
  };
}

async function rateContent({ contentId, contentOwnerId, fromUserId, transactionType }, options = {}) {
  const tabCoinsToDebitFromUser = -2;
  const tabCashToCreditToUser = 1;
  const tabCoinsToTransactToContentOwner = transactionType === 'credit' ? 1 : -1;
  const tabCoinsToTransactToContent = transactionType === 'credit' ? 1 : -1;
  const originatorType = 'event';
  const originatorId = options.eventId;

  const query = {
    text: `
      WITH users_tabcoin_inserts AS (
        INSERT INTO user_tabcoin_operations
          (recipient_id, amount, originator_type, originator_id)
        VALUES
          ($1, $2, $8, $9),
          ($6, $7, $8, $9)
        RETURNING
          *
      ),
      users_tabcash_insert AS (
        INSERT INTO user_tabcash_operations
          (recipient_id, amount, originator_type, originator_id)
        VALUES
          ($1, $3, $8, $9)
      ),
      content_insert AS (
        INSERT INTO content_tabcoin_operations
          (balance_type, recipient_id, amount, originator_type, originator_id)
        VALUES
          ($10, $4, $5, 'user', $1)
        RETURNING
          *
      )
      SELECT
        get_user_current_tabcoins($1) AS user_current_tabcoin_balance,
        tabcoins_count.total_balance as content_current_tabcoin_balance,
        tabcoins_count.total_credit as content_current_tabcoin_credit,
        tabcoins_count.total_debit as content_current_tabcoin_debit 
      FROM
        users_tabcoin_inserts,
        content_insert,
        get_content_balance_credit_debit(content_insert.recipient_id) tabcoins_count
      LIMIT
        1
    ;`,
    values: [
      fromUserId, // $1
      tabCoinsToDebitFromUser, // $2
      tabCashToCreditToUser, // $3

      contentId, // $4
      tabCoinsToTransactToContent, // $5

      contentOwnerId, // $6
      tabCoinsToTransactToContentOwner, // $7

      originatorType, // $8
      originatorId, // $9

      transactionType, // $10
    ],
  };

  const results = await database.query(query, options);
  const currentBalances = results.rows[0];

  if (currentBalances.user_current_tabcoin_balance < 0) {
    throw new UnprocessableEntityError({
      message: `Não foi possível adicionar TabCoins nesta publicação.`,
      action: `Você precisa de pelo menos ${Math.abs(tabCoinsToDebitFromUser)} TabCoins para realizar esta ação.`,
      errorLocationCode: 'MODEL:BALANCE:RATE_CONTENT:NOT_ENOUGH',
    });
  }

  return {
    tabcoins: currentBalances.content_current_tabcoin_balance,
    tabcoins_credit: currentBalances.content_current_tabcoin_credit,
    tabcoins_debit: currentBalances.content_current_tabcoin_debit,
  };
}

async function undo(balanceOperation, options) {
  const invertedBalanceOperation = {
    balanceType: balanceOperation.balance_type,
    recipientId: balanceOperation.recipient_id,
    amount: balanceOperation.amount * -1,
    originatorType: 'event',
    originatorId: options.event.id,
  };

  const newBalanceOperation = await create(invertedBalanceOperation, options);
  return newBalanceOperation;
}

export default Object.freeze({
  findAllByOriginatorId,
  create,
  getContentTabcoinsCreditDebit,
  rateContent,
  undo,
});
