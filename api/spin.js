import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const TEST_CODE = 'TEST-597300';

const PRIZES = [
  { id: 1, key: 'japan',  name_ms: 'Tiket Penerbangan ke Jepun', name_en: 'Japan Return Flight',   name_zh: '日本来回机票', emoji: '✈️', prob: 0.0071,  weekly_limit: 1   },
  { id: 2, key: 'vivo',   name_ms: 'VIVO Smartphone',            name_en: 'VIVO Smartphone',       name_zh: 'VIVO智能手机', emoji: '📱', prob: 0.0071,  weekly_limit: 1   },
  { id: 3, key: 'tng',    name_ms: 'RM500 TNG eWallet',          name_en: 'RM500 TNG eWallet',     name_zh: 'RM500电子钱包',emoji: '💳', prob: 0.0143,  weekly_limit: 2   },
  { id: 4, key: 'drinks', name_ms: 'Minuman Percuma Setahun',    name_en: 'Free Drinks for a Year', name_zh: '全年免费饮品', emoji: '🍹', prob: 0.0571,  weekly_limit: 8   },
  { id: 5, key: 'disc15', name_ms: 'Diskaun 15%',                name_en: '15% Discount Voucher',  name_zh: '15%折扣券',   emoji: '🏷', prob: 99.9144, weekly_limit: 9999},
];

function genVoucherCode() {
  return 'MMY-' + Date.now().toString(36).toUpperCase().slice(-4) +
         Math.random().toString(36).substring(2, 5).toUpperCase();
}

function getWeekStart() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const day = now.getUTCDay();
  const diff = now.getUTCDate() - day + (day === 0 ? -6 : 1);
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth()+1).padStart(2,'0');
  const d = String(diff).padStart(2,'0');
  return `${y}-${m}-${d}T00:00:00+08:00`;
}

function weightedRandomSync() {
  const total = PRIZES.reduce((a, p) => a + p.prob, 0);
  let r = Math.random() * total;
  for (const prize of PRIZES) {
    r -= prize.prob;
    if (r <= 0) return prize;
  }
  return PRIZES[4];
}

async function weightedDraw() {
  const weekStart = getWeekStart();
  const japanActive = process.env.JAPAN_ACTIVE === 'true';
  const vivoActive = process.env.VIVO_ACTIVE === 'true';
  const total = PRIZES.reduce((a, p) => a + p.prob, 0);
  let r = Math.random() * total;

  for (const prize of PRIZES) {
    r -= prize.prob;
    if (r <= 0) {
      if (prize.key === 'japan' && !japanActive) return PRIZES[4];
      if (prize.key === 'vivo' && !vivoActive) return PRIZES[4];
      if (prize.weekly_limit < 9999) {
        const { count } = await supabase
          .from('lottery_records')
          .select('*', { count: 'exact', head: true })
          .eq('prize_id', prize.id)
          .gte('drawn_at', weekStart);
        if ((count ?? 0) >= prize.weekly_limit) return PRIZES[4];
      }
      return prize;
    }
  }
  return PRIZES[4];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { order_no, store_name } = req.body;
  if (!order_no || !order_no.trim()) {
    return res.json({ success: false, reason_en: 'Please enter order number.' });
  }

  const cleanOrderNo = order_no.trim().replace(/\s+/g, '');

  // 测试暗号
  if (cleanOrderNo === TEST_CODE) {
    let prize = weightedRandomSync();
    if (prize.key === 'japan' && process.env.JAPAN_ACTIVE !== 'true') prize = PRIZES[4];
    if (prize.key === 'vivo' && process.env.VIVO_ACTIVE !== 'true') prize = PRIZES[4];
    return res.json({
      success: true, test_mode: true,
      prize_key: prize.key, prize_name_ms: prize.name_ms,
      prize_name_en: prize.name_en, prize_name_zh: prize.name_zh,
      prize_emoji: prize.emoji, voucher_code: 'TEST-ONLY', store_name: 'Test Store',
    });
  }

  // 防重复
  const { data: existing } = await supabase
    .from('lottery_records')
    .select('prize_name_ms, prize_name_en, prize_name_zh, prize_emoji')
    .eq('order_no', cleanOrderNo)
    .maybeSingle();

  if (existing) {
    return res.json({
      success: false, already_played: true,
      reason_ms: 'Pesanan ini telah menyertai cabutan.',
      reason_en: 'This order has already participated.',
      reason_zh: '该订单已参与过抽奖。',
    });
  }

  // TODO: 等Chattech开放IP白名单后在此加回订单验证
  const order = { storeId: '', storeName: store_name || '' };

  // 抽奖
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
    success: true,
    prize_key: prize.key, prize_name_ms: prize.name_ms,
    prize_name_en: prize.name_en, prize_name_zh: prize.name_zh,
    prize_emoji: prize.emoji, voucher_code: voucher,
    store_name: order.storeName,
  });
}

