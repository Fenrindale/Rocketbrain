<script setup lang="ts">
import CountBadge from './CountBadge.vue';
const count = 2;
</script>

<template>
  <h1>Rocketbrain Vue fixture</h1>
  <CountBadge :count="count" />
  <output>{{ count }}</output>
</template>
