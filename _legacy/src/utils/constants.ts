export const SLEEP_STAGES: Record<number, string> = {
  0: 'In Bed',
  1: 'Asleep',
  2: 'Awake',
  3: 'Core',
  4: 'Deep',
  5: 'REM',
};

interface MetricDefinition {
  dataType: string;
  defaultAggregation: 'avg' | 'sum' | 'min' | 'max' | 'latest';
  unit: string;
  perDay?: 'sum' | 'avg' | 'latest';
}

export const METRIC_MAP: Record<string, MetricDefinition> = {
  steps: {
    dataType: 'HKQuantityTypeIdentifierStepCount',
    defaultAggregation: 'sum',
    unit: 'count',
    perDay: 'sum',
  },
  active_energy: {
    dataType: 'HKQuantityTypeIdentifierActiveEnergyBurned',
    defaultAggregation: 'sum',
    unit: 'kcal',
    perDay: 'sum',
  },
  distance: {
    dataType: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
    defaultAggregation: 'sum',
    unit: 'm',
    perDay: 'sum',
  },
  heart_rate: {
    dataType: 'HKQuantityTypeIdentifierHeartRate',
    defaultAggregation: 'avg',
    unit: 'bpm',
    perDay: 'avg',
  },
  resting_hr: {
    dataType: 'HKQuantityTypeIdentifierRestingHeartRate',
    defaultAggregation: 'latest',
    unit: 'bpm',
    perDay: 'latest',
  },
  hrv: {
    dataType: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    defaultAggregation: 'avg',
    unit: 'ms',
    perDay: 'avg',
  },
  spo2: {
    dataType: 'HKQuantityTypeIdentifierOxygenSaturation',
    defaultAggregation: 'avg',
    unit: '%',
    perDay: 'avg',
  },
  respiratory_rate: {
    dataType: 'HKQuantityTypeIdentifierRespiratoryRate',
    defaultAggregation: 'avg',
    unit: 'breaths/min',
    perDay: 'avg',
  },
  weight: {
    dataType: 'HKQuantityTypeIdentifierBodyMass',
    defaultAggregation: 'latest',
    unit: 'kg',
    perDay: 'latest',
  },
  body_fat: {
    dataType: 'HKQuantityTypeIdentifierBodyFatPercentage',
    defaultAggregation: 'latest',
    unit: '%',
    perDay: 'latest',
  },
  vo2_max: {
    dataType: 'HKQuantityTypeIdentifierVO2Max',
    defaultAggregation: 'latest',
    unit: 'mL/kg·min',
    perDay: 'latest',
  },
  flights_climbed: {
    dataType: 'HKQuantityTypeIdentifierFlightsClimbed',
    defaultAggregation: 'sum',
    unit: 'count',
    perDay: 'sum',
  },
  basal_energy: {
    dataType: 'HKQuantityTypeIdentifierBasalEnergyBurned',
    defaultAggregation: 'sum',
    unit: 'kcal',
    perDay: 'sum',
  },
  walking_speed: {
    dataType: 'HKQuantityTypeIdentifierWalkingSpeed',
    defaultAggregation: 'avg',
    unit: 'km/hr',
    perDay: 'avg',
  },
};
