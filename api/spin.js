import { createClient } from '@supabase/supabase-js';
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
 
const CHATTECH_URL = 'https://iccup-bms.chattech.com/api/bms/order/order/list';
const ACTIVITY_START = '2026-05-01 00:00:00';
const ACTIVITY_END   = '2026-12-31 23:59:59';
const TEST_CODE = 'TEST-597300';
 
const PRIZES = [
  { id: 1, key: 'japan',  name_ms: 'Tiket Penerbangan ke Jepun', name_en: 'Japan Return Flight',  name_zh: '日本来回机票', emoji: '✈️', prob: 0.017, daily_limit: 1   },
  { id: 2, key: 'matcha', name_ms: 'Tiket Percuma Matcha',       name_en: 'Free Matcha Voucher',  name_zh: '抹茶免单券',   emoji: '🍵', prob: 31.47, daily_limit: 272 },
  { id: 3, key: 'disc15', name_ms: 'Diskaun 15%',                name_en: '15% Discount Voucher', name_zh: '15%折扣券',   emoji: '🏷', prob: 30.5,  daily_limit: 264 },
  { id: 4, key: 'disc10', name_ms: 'Diskaun 10%',                name_en: '10% Discount Voucher', name_zh: '10%折扣券',   emoji: '🎫', prob: 38.0,  daily_limit: 321 },
  { id: 5, key: 'thanks', name_ms: 'Terima Kasih',               name_en: 'Thank You',            name_zh: '谢谢惠顾',    emoji: '😊', prob: 0.0,   daily_limit: 999 },
];
 
function genVoucherCode() {
  return 'MMY-' + Date.now().toString(36).toUpperCase().slice(-4) +
         Math.random().toString(36).substring(2, 5).toUpperCase();
}
 
function weightedRandomSync() {
  const total = PRIZES.reduce((a, p) => a + p.prob, 0);
  let r = Math.random() * total;
  for (const prize of PRIZES) {
    r -= prize.prob;
    if (r <= 0) return prize;
  }
  return PRIZES[3];
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
        if ((count ?? 0) >= prize.daily_limit) continue;
      }
      return prize;
    }
  }
  // 所有奖品今日已派完，返回谢谢惠顾
  return PRIZES.find(p => p.key === 'thanks');
}
 
async function verifyOrder(orderNo) {
  const res = await fetch(CHATTECH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': process.env.CHATTECH_TOKEN,
    },
    body: JSON.stringify({
      orderQuery: orderNo,
      orderStatus: 0,
      orderStartTime: ACTIVITY_START,
      orderEndTime: ACTIVITY_END,
      orderPlatform: '',
      paymentMethod: '',
      pickupMethod: '',
      refundType: '',
      saleChannel: '',
      storeId: '',
      pageIndex: 1,
      pageSize: 1,
      selectedCompanyIdList: [],
      selectedOrgIdList: [],
    }),
  });
  const json = await res.json();
  if (!json.successful || !json.data?.list?.length) return null;
  const order = json.data.list[0];
  if (order.orderStatus !== 4) return null;
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
  if (!order_no || !order_no.trim()) {
    return res.json({
      success: false,
      reason_ms: 'Sila masukkan nombor pesanan.',
      reason_en: 'Please enter order number.',
      reason_zh: '请输入订单号。',
    });
  }
 
  const cleanOrderNo = order_no.trim();
 
  if (cleanOrderNo === TEST_CODE) {
    const prize = weightedRandomSync();
    return res.json({
      success:       true,
      test_mode:     true,
      prize_key:     prize.key,
      prize_name_ms: prize.name_ms,
      prize_name_en: prize.name_en,
      prize_name_zh: prize.name_zh,
      prize_emoji:   prize.emoji,
      voucher_code:  'TEST-ONLY-NO-RECORD',
      store_name:    'Test Store',
    });
  }
 
  const { data: existing } = await supabase
    .from('lottery_records')
    .select('prize_name_ms, prize_name_en, prize_name_zh, prize_emoji')
    .eq('order_no', cleanOrderNo)
    .maybeSingle();
 
  if (existing) {
    return res.json({
      success:       false,
      already_played: true,
      reason_ms:     'Pesanan ini telah menyertai cabutan.',
      reason_en:     'This order has already participated.',
      reason_zh:     '该订单已参与过抽奖。',
      prize_name_ms: existing.prize_name_ms,
      prize_name_en: existing.prize_name_en,
      prize_name_zh: existing.prize_name_zh,
      prize_emoji:   existing.prize_emoji,
    });
  }
 
  let order;
  try {
    order = await verifyOrder(cleanOrderNo);
  } catch (e) {
    return res.json({
      success:   false,
      reason_ms: 'Perkhidmatan tidak tersedia. Sila cuba lagi.',
      reason_en: 'Service unavailable. Please try again.',
      reason_zh: '验证服务暂时不可用，请稍后重试。',
    });
  }
 
  if (!order) {
    return res.json({
      success:   false,
      reason_ms: 'Pesanan tidak dijumpai atau tidak layak.',
      reason_en: 'Order not found or not eligible.',
      reason_zh: '订单不存在或不在活动范围内。',
    });
  }
 
  const prize = await weightedDraw();
  const voucher = genVoucherCode();
 
  await supabase.from('lottery_records').insert({
    order_no:      cleanOrderNo,
    store_id:      order.storeId,
    store_name:    order.storeName,
    prize_id:      prize.id,
    prize_key:     prize.key,
    prize_name_ms: prize.name_ms,
    prize_name_en: prize.name_en,
    prize_name_zh: prize.name_zh,
    prize_emoji:   prize.emoji,
    voucher_code:  voucher,
  });
 
  return res.json({
    success:       true,
    prize_key:     prize.key,
    prize_name_ms: prize.name_ms,
    prize_name_en: prize.name_en,
    prize_name_zh: prize.name_zh,
    prize_emoji:   prize.emoji,
    voucher_code:  voucher,
    store_name:    order.storeName,
  });
}
