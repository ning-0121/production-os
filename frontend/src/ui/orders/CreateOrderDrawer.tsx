import React from "react";
import { useForm } from "react-hook-form";
import { createAllocation } from "../../services/api";
import { useToast } from "../Toast";
import "./orders.css";

type FormData = {
  product_type: string;
  quantity: number;
  end_at: string;
  priority: number;
  order_external_id: string;
};

type Props = {
  onClose: () => void;
  onCreated: () => void;
};

export function CreateOrderDrawer({ onClose, onCreated }: Props) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = React.useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: {
      product_type: "",
      quantity: 1,
      end_at: "",
      priority: 0,
      order_external_id: "",
    },
  });

  async function onSubmit(data: FormData) {
    setSubmitting(true);
    try {
      await createAllocation({
        product_type: data.product_type,
        quantity: data.quantity,
        end_at: new Date(data.end_at).toISOString(),
        start_at: new Date().toISOString(),
        factory_id: undefined as unknown as string,
        priority: data.priority,
        order_external_id: data.order_external_id || undefined,
        status: "planned",
      });
      toast("订单创建成功", "success");
      onCreated();
    } catch (err) {
      toast(err instanceof Error ? err.message : "创建失败", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="drawerOverlay" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawerHeader">
          <h3>新建订单</h3>
          <button className="drawerClose" onClick={onClose}>x</button>
        </div>

        <form className="orderForm" onSubmit={handleSubmit(onSubmit)}>
          <label className="orderField">
            <span className="orderFieldLabel">产品类型 *</span>
            <input
              className="orderInput"
              placeholder="例如：T-SHIRT-L"
              {...register("product_type", { required: "请输入产品类型" })}
            />
            {errors.product_type && <span className="orderFieldError">{errors.product_type.message}</span>}
          </label>

          <label className="orderField">
            <span className="orderFieldLabel">数量 *</span>
            <input
              className="orderInput"
              type="number"
              min={1}
              {...register("quantity", {
                required: "请输入数量",
                valueAsNumber: true,
                min: { value: 1, message: "数量必须大于0" },
              })}
            />
            {errors.quantity && <span className="orderFieldError">{errors.quantity.message}</span>}
          </label>

          <label className="orderField">
            <span className="orderFieldLabel">交货日期 *</span>
            <input
              className="orderInput"
              type="date"
              {...register("end_at", { required: "请选择交货日期" })}
            />
            {errors.end_at && <span className="orderFieldError">{errors.end_at.message}</span>}
          </label>

          <label className="orderField">
            <span className="orderFieldLabel">优先级</span>
            <select className="orderInput" {...register("priority", { valueAsNumber: true })}>
              <option value={0}>普通</option>
              <option value={1}>较高</option>
              <option value={2}>紧急</option>
              <option value={3}>最高</option>
            </select>
          </label>

          <label className="orderField">
            <span className="orderFieldLabel">外部订单号</span>
            <input
              className="orderInput"
              placeholder="可选，关联外部系统"
              {...register("order_external_id")}
            />
          </label>

          <div className="orderActions">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="submit" className="btn primary" disabled={submitting}>
              {submitting ? "创建中..." : "创建订单"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
