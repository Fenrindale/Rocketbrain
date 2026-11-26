package previewfixture

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp

@Preview
@Composable
fun InventoryPreview() {
    Box(Modifier.fillMaxSize().background(Color(0xFFFF2244))) {
        Box(Modifier.size(20.dp).background(Color(0xFF2233FF)))
    }
}
