export type Factory = {
  id: string;
  name: string;
};

export type OrderBlock = {
  id: string;
  factoryId: string;
  productType: string;
  quantity: number;
  startAt: string; // ISO
  endAt: string; // ISO
  status: "planned" | "confirmed" | "in_progress" | "completed";
};

export type TimelineWindow = {
  start: Date;
  end: Date;
};

