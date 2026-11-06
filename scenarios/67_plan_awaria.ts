import { dependencyPlanScenario } from './66_plan_zaleznosci.js';

// Same controlled barriers; A fails in HTTP execution while independent B succeeds.
export default dependencyPlanScenario(true);
