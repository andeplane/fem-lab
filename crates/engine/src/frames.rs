//! Retained transient output through the same headless registry as final Results.

use crate::command::Field;
use crate::engine::{display, Engine};
use crate::error::{Error, ErrorCode};
use crate::post::FieldData;
use crate::procedure::vector_field;
use crate::query::{FrameResult, FrameSample, FrameStamp, FramesResult, ResolvedFrame, TimeSampling};
use crate::units::{Dim, Time};

/// Conversion roundoff scales with the physical times, including sub-second simulations.
fn time_close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 8.0 * f64::EPSILON * a.abs().max(b.abs())
}

/// Times are strictly increasing and nonempty: each transient retains its initial state.
fn time_index(times: &[f64], time: f64, sampling: TimeSampling) -> Result<usize, Error> {
    let upper = times.partition_point(|t| *t < time);
    let right = upper.min(times.len() - 1);
    let left = upper.saturating_sub(1);
    let a = (time - times[left]).abs();
    let b = (times[right] - time).abs();
    // SI conversion/subtraction can put a mathematical midpoint one ulp to either side.
    let index = if a <= b || time_close(a, b) { left } else { right };
    if time_close(time, times[index]) {
        return Ok(index);
    }
    if time < times[0] || time > times[times.len() - 1] {
        return Err(Error::new(
            ErrorCode::NotFound,
            format!("time {time} s is outside retained interval [{}, {}] s", times[0], times[times.len() - 1]),
        )
        .at("sample.time")
        .suggest("query.frames lists retained times; extrapolation is unavailable"));
    }
    if sampling == TimeSampling::Nearest {
        return Ok(index);
    }
    Err(Error::new(
        ErrorCode::NotFound,
        format!("time {time} s was not retained; neighboring times are {} s and {} s", times[left], times[right]),
    )
    .at("sample.time")
    .suggest("query.frames, or explicitly request sample.sampling 'nearest'"))
}

impl Engine {
    /// Metadata and explicit selections read the immutable solved record.
    fn frame_stamp(model: &crate::model::Model, index: usize, time: f64) -> FrameStamp {
        FrameStamp { index: index as u32, time_si: time, time: display(model, time, Time::DIM) }
    }

    pub(crate) fn query_frames(&self, step: Option<&str>, id: Option<&str>) -> Result<FramesResult, Error> {
        let record = self.record(step, id)?;
        let history = record.history()?;
        let nodes = record.built.mesh.n_nodes();
        let model = if id.is_some() { &record.model } else { &self.model };
        Ok(FramesResult {
            result_id: record.id.clone(),
            step: record.step.clone(),
            model_hash: record.model_hash.clone(),
            stale: record.input_hash != crate::hash::result_hash(&self.model),
            node_count: nodes,
            field: history.field,
            components: 3,
            stored_components: history.values[0].len() / nodes,
            retained_bytes: 8 * (history.times.len() + history.values.iter().map(Vec::len).sum::<usize>()) as u64,
            frames: history.times.iter().enumerate().map(|(i, t)| Self::frame_stamp(model, i, *t)).collect(),
        })
    }

    pub(crate) fn sampled_frame(
        &self,
        step: Option<&str>,
        id: Option<&str>,
        field: Option<Field>,
        sample: &FrameSample,
    ) -> Result<(FieldData, ResolvedFrame, Field), Error> {
        let record = self.selected_record(step, id)?;
        let name = &record.step;
        let history = record.history()?;
        let nodes = record.built.mesh.n_nodes();
        let model = if id.is_some() { &record.model } else { &self.model };
        let selected = field.unwrap_or(history.field);
        if selected != history.field {
            return Err(Error::new(
                ErrorCode::Unsupported,
                format!("{selected:?} was not retained; step '{name}' retains only {:?}", history.field),
            )
            .at("field")
            .suggest("query.frames lists available primary fields; omit sample for a final derived field"));
        }
        let index = match sample {
            FrameSample::Frame { index } => *index as usize,
            FrameSample::Time { time, sampling } => {
                time_index(&history.times, time.si().map_err(|e| e.at("sample.time"))?, *sampling)?
            }
        };
        let values = history.values.get(index).ok_or_else(|| {
            Error::new(ErrorCode::NotFound, format!("retained frame {index} is outside 0..{}", history.times.len()))
                .at("index")
                .suggest("query.frames lists zero-based retained indices")
        })?;
        let resolved = ResolvedFrame {
            result_id: record.id.clone(),
            step: name.clone(),
            model_hash: record.model_hash.clone(),
            frame: Self::frame_stamp(model, index, history.times[index]),
        };
        Ok((vector_field(values, values.len() / nodes), resolved, selected))
    }

    pub(crate) fn query_frame(
        &self,
        step: Option<&str>,
        id: Option<&str>,
        index: Option<u32>,
        sample: Option<FrameSample>,
        field: Option<Field>,
    ) -> Result<FrameResult, Error> {
        let selected = match (index, sample) {
            (Some(index), None) => FrameSample::Frame { index },
            (None, Some(sample)) => sample,
            _ => {
                return Err(Error::new(ErrorCode::Schema, "query.frame requires exactly one of index or sample")
                    .at("sample")
                    .suggest("query.frames, then query.frame with index or a physical-time sample"));
            }
        };
        let (values, sample, field) = self.sampled_frame(step, id, field, &selected)?;
        Ok(FrameResult {
            sample,
            field,
            components: values.comps,
            node_count: values.len(),
            unit: if field == Field::Temperature { "K" } else { "m" }.into(),
            values: values.data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_midpoint_ties_survive_roundoff_at_each_time_scale() {
        for scale in [1e-12, 1.0, 1e12] {
            let times = [0.0, 0.3 * scale, 0.6 * scale, 0.9 * scale];
            assert_eq!(time_index(&times, 0.45 * scale, TimeSampling::Nearest).unwrap(), 1);
            assert_eq!(time_index(&times, 0.450001 * scale, TimeSampling::Nearest).unwrap(), 2);
            assert_eq!(time_index(&times, 0.449999 * scale, TimeSampling::Nearest).unwrap(), 1);
            assert!(time_index(&times, 0.300001 * scale, TimeSampling::Exact).is_err());
        }
    }
}
