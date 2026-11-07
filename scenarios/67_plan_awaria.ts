/** Ten sam rzeczywisty plan co 66, lecz model A zwraca HTTP 400.
 * C pozostaje blocked z przyczyną A i pustym dorobkiem; B kończy normalnie.
 * Raport trafia raz per węzeł do prowadzącego, który decyduje o nowym delegate.
 */
import { dependencyPlanScenario } from './66_plan_zaleznosci.js';

export default dependencyPlanScenario(true);
