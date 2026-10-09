package com.medicaljava.volumerestservice.model;

public class Slice {

    private int sliceId;
    private int volumeId;
    private int patientId;
    private Volume volume;
    private Patient patient;
    private int index;
    private int width;
    private int height;
    private short[] radiodensities;

    public int getSliceId() {
        return sliceId;
    }

    public void setSliceId(int sliceId) {
        this.sliceId = sliceId;
    }

    public int getVolumeId() {
        return volumeId;
    }

    public void setVolumeId(int volumeId) {
        this.volumeId = volumeId;
    }

    public int getPatientId() {
        return patientId;
    }

    public void setPatientId(int patientId) {
        this.patientId = patientId;
    }

    public Volume getVolume() {
        return volume;
    }

    public void setVolume(Volume volume) {
        this.volume = volume;
    }

    public Patient getPatient() {
        return patient;
    }

    public void setPatient(Patient patient) {
        this.patient = patient;
    }

    public int getIndex() {
        return index;
    }

    public void setIndex(int index) {
        this.index = index;
    }

    public int getWidth() {
        return width;
    }

    public void setWidth(int width) {
        this.width = width;
    }

    public int getHeight() {
        return height;
    }

    public void setHeight(int height) {
        this.height = height;
    }

    public short[] getRadiodensities() {
        return radiodensities;
    }

    public void setRadiodensities(short[] radiodensities) {
        this.radiodensities = radiodensities;
    }
}
