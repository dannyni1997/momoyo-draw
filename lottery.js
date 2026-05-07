import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const CHATTECH_URL = 'https://iccup-bms.chattech.com/api/bms/pay/payment/list';
const ACTIVITY_START = '2026-05-01';
const ACTIVITY_END   = '2026-12-31';

const PRIZES = [
  { id: 1, name: 'RM50 现金大奖', emoji: '💰', prob: 1,  daily_limit: 2   },
  { id: 2, name: '免费饮品券',    emoji: '🧋', prob: 15, daily_limit: 50  },
  { id: 3, name: '品牌周边礼品', emoji: '🛍', prob: 9,  daily_limit: 10  },
  { id: 4, name: '8折优惠券',    emoji: '🏷', prob: 25, daily_limit: 999 },
  { id: 5, name: '积分 +50',     emoji: '⭐', prob: 50, daily_limit: 999 },
];

function genVoucherCode() {
  return 'MYO-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function weightedDraw() {
  const today = new Date().toISOString().slice(0, 10);
  const total = PRIZES.reduce((a, p) => a + p.prob, 0);
  let r = Math.random() * total;

  for (const prize of PRIZES) {
    r -= prize.prob;
    if (r <= 0) {
      if (prize.daily_limit < 999) {
        const { count } = await supabase
          .from('lottery_records')
          .select('*', { count: 'exact', head: true })
          .eq('prize_id', prize.id)
          .gte('drawn_at', today);
        if (count >= prize.daily_limit) continue;
      }
      return prize;
    }
  }
  return PRIZES[PRIZES.length - 1];
}

async function verifyOrder(orderNo) {
  const res = await fetch(CHATTECH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': process.env.CHATTECH_TOKEN,
    },
    body: JSON.stringify({
      keyword: orderNo,
      pageIndex: 1,
      pageSize: 1,
      payUpdateTimeGte: ACTIVITY_START,
      payUpdateTimeLte: ACTIVITY_END,
      status: '',
      methodId: '',
      payStoreId: '',
      sceneId: '',
      selectedCompanyIdList: [],
      selectedOrgIdList: [],
    }),
  });
  const json = await res.json();
  if (!json.successful || !json.data?.list?.length) return null;
  const order = json.data.list[0];
  if (order.status !== 3) return null;
  if (order.orderNo !== orderNo) return null;
  return order;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.replace(/\?.*$/, '');

  // ── 抽奖 ──────────────────────────────────────────────
  if (path === '/api/lottery/spin' && req.method === 'POST') {
    const { order_no } = req.body;
    if (!order_no) return res.json({ success: false, reason: '请输入订单号' });

    // 防重复
    const { data: existing } = await supabase
      .from('lottery_records')
      .select('prize_name, voucher_code')
      .eq('order_no', order_no)
      .maybeSingle();

    if (existing) {
      return res.json({
        success: false,
        reason: '该订单已参与过抽奖',
        prize_name: existing.prize_name,
        voucher_code: existing.voucher_code,
      });
    }

    // 验证订单
    let order;
    try { order = await verifyOrder(order_no); }
    catch { return res.json({ success: false, reason: '验证服务暂时不可用，请稍后重试' }); }
    if (!order) return res.json({ success: false, reason: '订单不存在或不在活动范围内' });

    // 抽奖
    const prize = await weightedDraw();
    const voucher = genVoucherCode();

    await supabase.from('lottery_records').insert({
      order_no,
      store_id:    order.storeId,
      store_name:  order.storeName,
      prize_id:    prize.id,
      prize_name:  prize.name,
      prize_emoji: prize.emoji,
      voucher_code: voucher,
    });

    return res.json({
      success:     true,
      prize_name:  prize.name,
      prize_emoji: prize.emoji,
      voucher_code: voucher,
      store_name:  order.storeName,
    });
  }

  // ── 后台查询 ───────────────────────────────────────────
  if (path === '/api/admin/records' && req.method === 'GET') {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ error: '无权限' });

    const { page = 1, limit = 20, store_id, date } = req.query;
    let query = supabase.from('lottery_records').select('*', { count: 'exact' });
    if (store_id) query = query.eq('store_id', store_id);
    if (date)     query = query.gte('drawn_at', date).lt('drawn_at', date + 'T23:59:59');
    query = query.order('drawn_at', { ascending: false })
                 .range((page - 1) * limit, page * limit - 1);

    const { data, count } = await query;
    return res.json({ success: true, total: count, page: +page, data });
  }

  // ── 核销 ───────────────────────────────────────────────
  if (path === '/api/admin/redeem' && req.method === 'POST') {
    if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ error: '无权限' });

    const { voucher_code } = req.body;
    const { data: record } = await supabase
      .from('lottery_records')
      .select('*')
      .eq('voucher_code', voucher_code)
      .maybeSingle();

    if (!record) return res.json({ success: false, reason: '券码不存在' });
    if (record.redeemed) return res.json({ success: false, reason: '该券已核销' });

    await supabase.from('lottery_records')
      .update({ redeemed: true, redeemed_at: new Date().toISOString() })
      .eq('voucher_code', voucher_code);

    return res.json({ success: true, prize_name: record.prize_name, store_name: record.store_name });
  }

  return res.status(404).json({ error: 'Not found' });
}
