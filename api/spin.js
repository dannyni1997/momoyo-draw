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
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
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
    store_id:     order.storeId,
    store_name:   order.storeName,
    prize_id:     prize.id,
    prize_name:   prize.name,
    prize_emoji:  prize.emoji,
    voucher_code: voucher,
  });
 
  return res.json({
    success:      true,
    prize_name:   prize.name,
    prize_emoji:  prize.emoji,
    voucher_code: voucher,
    store_name:   order.storeName,
  });
}
 
