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

export type DataTypeKey = keyof typeof DATA_TYPE_MAP;

export type SampleKind = 'quantity' | 'category' | 'workout';

export type APISample = {
  uuid: string;
  value: number | string;
  unit: string;
  start_date: string;
  end_date: string;
  source_name: string;
  source_bundle_id: string;
};

export type IngestRequest = {
  device_id: string;
  data_type: DataTypeKey;
  new_samples: APISample[];
  deleted_ids: string[];
};
