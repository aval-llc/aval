/** One stop per overarching workspace module, followed by the chat surface. */
export const TOUR_MODULES = ['overview','setup','inbox','properties','leasing','maintenance','accounting','infrastructure','calendar','projects','teams','connections','documents','settings','chat'] as const;
export type TourModule = typeof TOUR_MODULES[number];
