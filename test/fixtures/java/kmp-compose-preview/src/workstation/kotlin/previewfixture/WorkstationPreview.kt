package previewfixture

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import java.awt.Color as AwtColor

private object WorkstationPalette {
    fun background(): Color {
        val resource = requireNotNull(WorkstationPalette::class.java.getResource("/rocketbrain-preview/desktop-color.txt"))
        val awt = AwtColor.decode(resource.readText().trim())
        return Color(awt.red, awt.green, awt.blue)
    }
}

@Preview
@Composable
internal fun WorkstationPreview() {
    Box(Modifier.fillMaxSize().background(WorkstationPalette.background()))
}
