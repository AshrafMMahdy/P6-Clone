// The vocabularies of the PQ-VAE engine (pqvae/whiqcodes/schemas.py): project types, trades and build phases. The order is the model's one-hot order.
export const PROJECT_TYPES = ['Residential', 'Office', 'Hospital', 'School', 'Industrial', 'Road', 'Bridge', 'Rail', 'Metro', 'Airport', 'Stadium'];
export const TRADES = ['general', 'civil', 'structure', 'architecture', 'mep_mech', 'mep_elec', 'mep_plumb', 'finishes', 'commissioning'];
export const PHASES = ['mobilization', 'substructure', 'superstructure', 'envelope', 'rough_in', 'finishes', 'commissioning'];
export const CALIBRATION = 'v2-minilm';   // the label every answer carries (sidecar.py CALIBRATION): multilingual MiniLM text block, 5 EPC programmes in the activity corpus
