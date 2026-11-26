package dev.rocketbrain.androidfixture

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "Rocketbrain Android test" })
        val handler = Handler(Looper.getMainLooper())
        handler.postDelayed(object : Runnable {
            override fun run() {
                observedWork(40)
                handler.postDelayed(this, 1800L)
            }
        }, 1200L)
    }

    private fun observedWork(input: Int) {
        val measured = input + 2
        Log.i("RBAndroidFixture", "Paused line " + measured) // SOURCE_STOP
        Log.i("RBAndroidFixture", "Finished " + measured)
    }
}
