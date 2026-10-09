package com.medicaljava.volumerestservice.model;

import java.util.List;

public record Patient (int patientId, String name, List<Volume> volumes) {}