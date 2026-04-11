-- Migration 005: v4.0-alpha — Orders, Materials, BOM, Procurement, QC
-- Restructures order model and adds material/quality tracking

BEGIN;

-- ══════════════════════════════════════════════════════════
-- 1) customers — 客户主表
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  country text,
  payment_terms text,
  vip_level text DEFAULT 'standard' CHECK (vip_level IN ('platinum','gold','silver','standard')),
  credit_limit numeric(14,2),
  avg_margin_pct numeric(6,2),
  return_rate_pct numeric(6,2),
  payment_cycle_days integer,
  total_orders_ytd integer DEFAULT 0,
  total_revenue_ytd numeric(14,2) DEFAULT 0,
  risk_level text DEFAULT 'low' CHECK (risk_level IN ('low','medium','high')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_vip ON public.customers(vip_level);

-- ══════════════════════════════════════════════════════════
-- 2) orders — 订单主表（从 production_allocations 拆出）
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text NOT NULL UNIQUE,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  style_number text,
  product_type text NOT NULL,
  total_qty integer NOT NULL,
  unit_price numeric(10,2),
  currency text DEFAULT 'USD',
  due_date text,
  ship_date text,
  season text,
  priority integer DEFAULT 0,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','in_production','shipped','completed','cancelled')),
  bom_id uuid,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON public.orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_due ON public.orders(due_date);
CREATE INDEX IF NOT EXISTS idx_orders_product ON public.orders(product_type);

-- Link allocations to orders
ALTER TABLE public.production_allocations
  ADD COLUMN IF NOT EXISTS order_ref_id uuid REFERENCES public.orders(id) ON DELETE SET NULL;

-- ══════════════════════════════════════════════════════════
-- 3) materials — 物料主表
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('fabric','trim','packaging','sample','remnant')),
  sub_category text,
  unit text NOT NULL DEFAULT 'yard',
  spec jsonb DEFAULT '{}'::jsonb,
  default_supplier_id uuid,
  safety_stock_qty numeric(14,2) DEFAULT 0,
  lead_time_days integer DEFAULT 14,
  status text DEFAULT 'active' CHECK (status IN ('active','discontinued')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_materials_category ON public.materials(category);
CREATE INDEX IF NOT EXISTS idx_materials_code ON public.materials(code);

-- ══════════════════════════════════════════════════════════
-- 4) material_colors — 物料颜色（同布不同色）
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.material_colors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE CASCADE,
  color_code text NOT NULL,
  color_name text,
  pantone text,
  dye_lot text,
  status text DEFAULT 'active' CHECK (status IN ('active','exhausted')),
  UNIQUE (material_id, color_code)
);

-- ══════════════════════════════════════════════════════════
-- 5) material_inventory — 库存
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.material_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE CASCADE,
  color_id uuid REFERENCES public.material_colors(id) ON DELETE SET NULL,
  warehouse text DEFAULT 'main',
  qty_on_hand numeric(14,2) NOT NULL DEFAULT 0,
  qty_reserved numeric(14,2) NOT NULL DEFAULT 0,
  qty_available numeric(14,2) GENERATED ALWAYS AS (qty_on_hand - qty_reserved) STORED,
  last_updated timestamptz DEFAULT now(),
  UNIQUE (material_id, color_id, warehouse)
);

CREATE INDEX IF NOT EXISTS idx_inventory_material ON public.material_inventory(material_id);

-- ══════════════════════════════════════════════════════════
-- 6) bom_templates — BOM 模板
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bom_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_number text NOT NULL,
  product_type text NOT NULL,
  size_category text DEFAULT 'missy',
  version integer DEFAULT 1,
  status text DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_number, size_category, version)
);

-- ══════════════════════════════════════════════════════════
-- 7) bom_lines — BOM 行项
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id uuid NOT NULL REFERENCES public.bom_templates(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  color_id uuid REFERENCES public.material_colors(id) ON DELETE SET NULL,
  size_group text DEFAULT 'all',
  usage_qty numeric(10,4) NOT NULL,
  usage_unit text DEFAULT 'yard',
  waste_pct numeric(5,2) DEFAULT 3,
  is_critical boolean DEFAULT true,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_bom_lines_bom ON public.bom_lines(bom_id);
CREATE INDEX IF NOT EXISTS idx_bom_lines_material ON public.bom_lines(material_id);

-- ══════════════════════════════════════════════════════════
-- 8) suppliers — 供应商
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text DEFAULT 'fabric' CHECK (category IN ('fabric','trim','packaging','logistics','other')),
  contact_name text,
  contact_phone text,
  contact_email text,
  payment_terms text,
  lead_time_days integer DEFAULT 14,
  quality_score numeric(5,2) DEFAULT 80,
  delivery_score numeric(5,2) DEFAULT 80,
  price_score numeric(5,2) DEFAULT 80,
  status text DEFAULT 'active' CHECK (status IN ('active','blocked','probation')),
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- 9) purchase_orders — 采购单
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES public.suppliers(id) ON DELETE RESTRICT,
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','confirmed','partial','received','cancelled')),
  total_amount numeric(14,2),
  currency text DEFAULT 'CNY',
  expected_date text,
  actual_date text,
  delay_days integer,
  notes text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_supplier ON public.purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_po_status ON public.purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_po_order ON public.purchase_orders(order_id);

-- ══════════════════════════════════════════════════════════
-- 10) purchase_order_lines — 采购行项
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  color_id uuid REFERENCES public.material_colors(id) ON DELETE SET NULL,
  qty_ordered numeric(14,2) NOT NULL,
  unit_price numeric(10,4),
  qty_received numeric(14,2) DEFAULT 0,
  qty_rejected numeric(14,2) DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_po_lines_po ON public.purchase_order_lines(po_id);

-- ══════════════════════════════════════════════════════════
-- 11) fabric_inspections — 验布报告
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.fabric_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_line_id uuid REFERENCES public.purchase_order_lines(id) ON DELETE SET NULL,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  inspector text,
  inspection_date text,
  roll_count integer,
  weight_actual numeric(8,2),
  weight_spec numeric(8,2),
  weight_deviation_pct numeric(5,2),
  shrinkage_pct numeric(5,2),
  color_delta_e numeric(5,2),
  width_actual numeric(8,2),
  width_spec numeric(8,2),
  defect_points integer DEFAULT 0,
  grade text DEFAULT 'pass' CHECK (grade IN ('pass','conditional','fail')),
  allow_cutting boolean DEFAULT false,
  notes text,
  photos jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════
-- 12) material_requirements — 物料需求（自动计算）
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.material_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  bom_id uuid REFERENCES public.bom_templates(id) ON DELETE SET NULL,
  material_id uuid NOT NULL REFERENCES public.materials(id) ON DELETE RESTRICT,
  color_id uuid REFERENCES public.material_colors(id) ON DELETE SET NULL,
  required_qty numeric(14,2) NOT NULL DEFAULT 0,
  available_qty numeric(14,2) DEFAULT 0,
  shortage_qty numeric(14,2) DEFAULT 0,
  po_id uuid REFERENCES public.purchase_orders(id) ON DELETE SET NULL,
  status text DEFAULT 'pending' CHECK (status IN ('sufficient','shortage','ordered','received')),
  computed_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mat_req_order ON public.material_requirements(order_id);
CREATE INDEX IF NOT EXISTS idx_mat_req_status ON public.material_requirements(status);

-- ══════════════════════════════════════════════════════════
-- 13) qc_inspections — QC 检验
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.qc_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  factory_id uuid REFERENCES public.factories(id) ON DELETE SET NULL,
  inspection_type text NOT NULL CHECK (inspection_type IN ('pp_sample','shipping_sample','inline','final','third_party')),
  inspector text,
  inspection_date text,
  total_qty_inspected integer DEFAULT 0,
  total_defects integer DEFAULT 0,
  defect_rate_pct numeric(5,2) DEFAULT 0,
  aql_level text DEFAULT '2.5',
  result text DEFAULT 'pending' CHECK (result IN ('pending','pass','fail','conditional')),
  photos jsonb DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_qc_order ON public.qc_inspections(order_id);
CREATE INDEX IF NOT EXISTS idx_qc_factory ON public.qc_inspections(factory_id);
CREATE INDEX IF NOT EXISTS idx_qc_type ON public.qc_inspections(inspection_type);

-- ══════════════════════════════════════════════════════════
-- 14) qc_defects — 缺陷明细
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.qc_defects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES public.qc_inspections(id) ON DELETE CASCADE,
  defect_code text NOT NULL,
  severity text DEFAULT 'minor' CHECK (severity IN ('critical','major','minor')),
  qty integer DEFAULT 1,
  location text,
  photo_url text,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_qc_defects_insp ON public.qc_defects(inspection_id);

-- ══════════════════════════════════════════════════════════
-- 15) defect_library — 缺陷字典
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.defect_library (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name_cn text NOT NULL,
  name_en text,
  category text CHECK (category IN ('sewing','fabric','finishing','packing','other')),
  severity_default text DEFAULT 'minor',
  product_types text[] DEFAULT '{}',
  description text
);

-- Seed common defects
INSERT INTO public.defect_library (code, name_cn, name_en, category, severity_default, product_types) VALUES
  ('DEF-001', '起球', 'Pilling', 'fabric', 'major', '{"leggings","hoodie"}'),
  ('DEF-002', '露白', 'White Show-through', 'fabric', 'major', '{"leggings","bra"}'),
  ('DEF-003', '跳线', 'Skipped Stitch', 'sewing', 'major', '{}'),
  ('DEF-004', '车缝歪', 'Crooked Seam', 'sewing', 'major', '{}'),
  ('DEF-005', '脏污', 'Stain', 'finishing', 'minor', '{}'),
  ('DEF-006', '色差', 'Color Shade Difference', 'fabric', 'critical', '{}'),
  ('DEF-007', '尺寸误差', 'Measurement Out of Tolerance', 'sewing', 'critical', '{}'),
  ('DEF-008', '包装错误', 'Packing Error', 'packing', 'major', '{}'),
  ('DEF-009', '箱唛错误', 'Carton Mark Error', 'packing', 'major', '{}'),
  ('DEF-010', '漏件', 'Missing Piece', 'packing', 'critical', '{}')
ON CONFLICT (code) DO NOTHING;

-- ══════════════════════════════════════════════════════════
-- 16) rework_orders — 返工单
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.rework_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  inspection_id uuid REFERENCES public.qc_inspections(id) ON DELETE SET NULL,
  factory_id uuid REFERENCES public.factories(id) ON DELETE SET NULL,
  rework_qty integer NOT NULL,
  rework_reason text,
  defect_codes text[],
  estimated_days integer,
  actual_days integer,
  cost numeric(10,2),
  responsible_party text DEFAULT 'factory' CHECK (responsible_party IN ('factory','material','design','customer')),
  impact_on_delivery boolean DEFAULT false,
  delay_days integer DEFAULT 0,
  status text DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','waived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rework_order ON public.rework_orders(order_id);

-- ══════════════════════════════════════════════════════════
-- 17) order_financials — 订单损益
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.order_financials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE UNIQUE,
  revenue numeric(14,2) DEFAULT 0,
  fabric_cost numeric(14,2) DEFAULT 0,
  trim_cost numeric(14,2) DEFAULT 0,
  cmt_cost numeric(14,2) DEFAULT 0,
  rework_cost numeric(14,2) DEFAULT 0,
  freight_cost numeric(14,2) DEFAULT 0,
  duty_cost numeric(14,2) DEFAULT 0,
  compensation_cost numeric(14,2) DEFAULT 0,
  other_cost numeric(14,2) DEFAULT 0,
  gross_profit numeric(14,2) GENERATED ALWAYS AS (
    revenue - fabric_cost - trim_cost - cmt_cost - rework_cost - freight_cost - duty_cost - compensation_cost - other_cost
  ) STORED,
  gross_margin_pct numeric(6,2),
  status text DEFAULT 'estimated' CHECK (status IN ('estimated','actual','closed')),
  computed_at timestamptz DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
