import PredictionPlannerClient from "./client";
import { pageMetadata } from "@/lib/seo-metadata";

export const generateMetadata = pageMetadata("prediction_planner");

export default function PredictionPlannerPage() {
    return <PredictionPlannerClient />;
}
