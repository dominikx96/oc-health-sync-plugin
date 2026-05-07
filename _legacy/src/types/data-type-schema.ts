export const DATA_TYPE_MAP = {
  steps: {
    identifier: 'HKQuantityTypeIdentifierStepCount',
    kind: 'quantity',
    unit: 'count',
  },
  active_energy: {
    identifier: 'HKQuantityTypeIdentifierActiveEnergyBurned',
    kind: 'quantity',
    unit: 'kcal',
  },
  distance_walking_running: {
    identifier: 'HKQuantityTypeIdentifierDistanceWalkingRunning',
    kind: 'quantity',
    unit: 'km',
  },
  heart_rate: {
    identifier: 'HKQuantityTypeIdentifierHeartRate',
    kind: 'quantity',
    unit: 'bpm',
  },
  resting_heart_rate: {
    identifier: 'HKQuantityTypeIdentifierRestingHeartRate',
    kind: 'quantity',
    unit: 'bpm',
  },
  heart_rate_variability: {
    identifier: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    kind: 'quantity',
    unit: 'ms',
  },
  blood_oxygen: {
    identifier: 'HKQuantityTypeIdentifierOxygenSaturation',
    kind: 'quantity',
    unit: '%',
  },
  respiratory_rate: {
    identifier: 'HKQuantityTypeIdentifierRespiratoryRate',
    kind: 'quantity',
    unit: 'breaths/min',
  },
  weight: {
    identifier: 'HKQuantityTypeIdentifierBodyMass',
    kind: 'quantity',
    unit: 'kg',
  },
  body_fat_percentage: {
    identifier: 'HKQuantityTypeIdentifierBodyFatPercentage',
    kind: 'quantity',
    unit: '%',
  },
  vo2_max: {
    identifier: 'HKQuantityTypeIdentifierVO2Max',
    kind: 'quantity',
    unit: 'mL/kg·min',
  },
  flights_climbed: {
    identifier: 'HKQuantityTypeIdentifierFlightsClimbed',
    kind: 'quantity',
    unit: 'count',
  },
  basal_energy: {
    identifier: 'HKQuantityTypeIdentifierBasalEnergyBurned',
    kind: 'quantity',
    unit: 'kcal',
  },
  walking_speed: {
    identifier: 'HKQuantityTypeIdentifierWalkingSpeed',
    kind: 'quantity',
    unit: 'km/hr',
  },
  sleep_analysis: {
    identifier: 'HKCategoryTypeIdentifierSleepAnalysis',
    kind: 'category',
    unit: 'category',
  },
  workouts: {
    identifier: 'HKWorkoutTypeIdentifier',
    kind: 'workout',
    unit: 'workout',
  },
} as const;
