import React from "react";
import { useForm } from "react-hook-form";
import { createAllocation } from "../../services/api";
import { useToast } from "../Toast";
import "./orders.css";

type FormData = {
  quantity: number;
  end_date: string;
  order_id: string;
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
      quantity: 1,
      end_date: "",
      order_id: "",
    },
  });

  async function onSubmit(data: FormData) {
    setSubmitting(true);
    try {
      await createAllocation({
        allocated_qty: data.quantity,
        planned_end_date: new Date(data.end_date).toISOString(),
        planned_start_date: new Date().toISOString(),
        order_id: data.order_id || undefined,
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
              {...register("end_date", { required: "请选择交货日期" })}
            />
            {errors.end_date && <span className="orderFieldError">{errors.end_date.message}</span>}
          </label>

          <label className="orderField">
            <span className="orderFieldLabel">订单号</span>
            <input
              className="orderInput"
              placeholder="可选，关联外部系统"
              {...register("order_id")}
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
